import type { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as path from 'node:path';
import {
  ClientSideConnection,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type InitializeResponse,
  type NewSessionResponse,
  type LoadSessionResponse,
  type PromptResponse,
  type AnyMessage,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import type { AcpBackend, AcpSessionConfigOption, AcpSessionModels } from '@/common/types/acpTypes';
import type { SessionConfigOptionCategory } from '@agentclientprotocol/sdk';
import type { AcpSessionMcpServer } from '../config/mcpSessionConfig';
import { createNdJsonMessageStream, createTappedStream, requireAgentStdio, isChildProcessRunning } from '../core';
import { ResettableTimer } from './ResettableTimer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AcpConnectionHandlers = {
  /** Called on every session/update notification. */
  onSessionUpdate: (params: SessionNotification) => void;
  /** Called when the agent requests permission for a tool call. */
  onPermissionRequest: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  /** Called for readTextFile requests (if fs capability advertised). */
  onReadTextFile?: (params: ReadTextFileRequest) => Promise<ReadTextFileResponse>;
  /** Called for writeTextFile requests (if fs capability advertised). */
  onWriteTextFile?: (params: WriteTextFileRequest) => Promise<WriteTextFileResponse>;
  /** Called when the connection drops (process exit, stream end, etc.). */
  onDisconnect?: (error?: Error) => void;
  /** Called on every inbound/outbound message (for logging / debug trace). */
  onMessage?: (direction: 'inbound' | 'outbound', message: AnyMessage) => void;
};

export type AcpConnectionOptions = {
  backend: AcpBackend;
  workingDir: string;
  /** Prompt timeout in ms (default 300_000 = 5 min). */
  promptTimeoutMs?: number;
  /** Default request timeout for non-prompt methods in ms (default 60_000). */
  requestTimeoutMs?: number;
  /** Filter for non-JSON lines from agent stdout. */
  ignoreLine?: (line: string) => boolean;
};

// ---------------------------------------------------------------------------
// AcpConnection
// ---------------------------------------------------------------------------

/**
 * ACP connection layer built on top of `@agentclientprotocol/sdk`'s
 * `ClientSideConnection`.
 *
 * Responsibilities:
 * - Converts child process stdio → ndjson → SDK connection
 * - Manages prompt timeout (pause on permission, reset on streaming update)
 * - Caches session capabilities (configOptions, models)
 * - Exposes typed session methods
 *
 * Does NOT handle: process spawning (connector's job), session resume
 * strategy (SessionManager's job), model/mode logic (ModelManager/ModeManager).
 */
export class AcpConnection {
  // -- Config --
  private readonly backend: AcpBackend;
  private readonly workingDir: string;
  private promptTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly handlers: AcpConnectionHandlers;
  private readonly ignoreLine?: (line: string) => boolean;

  // -- SDK connection --
  private sdkConnection: ClientSideConnection | null = null;
  private child: ChildProcess | null = null;

  // -- Session state --
  private sessionId: string | null = null;
  private initializeResponse: InitializeResponse | null = null;
  private configOptions: AcpSessionConfigOption[] | null = null;
  private models: AcpSessionModels | null = null;

  // -- Prompt timeout --
  private promptTimer: ResettableTimer | null = null;

  constructor(handlers: AcpConnectionHandlers, options: AcpConnectionOptions) {
    this.handlers = handlers;
    this.backend = options.backend;
    this.workingDir = options.workingDir;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 300_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.ignoreLine = options.ignoreLine;
  }

  // =========================================================================
  // Connection lifecycle
  // =========================================================================

  /**
   * Wire up a spawned child process to the SDK's ClientSideConnection.
   * Call this after the connector has spawned the agent process.
   */
  setup(child: ChildProcess): void {
    const typedChild = requireAgentStdio(child);
    this.child = child;

    // Node streams → Web streams
    const output = Writable.toWeb(typedChild.stdin) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(typedChild.stdout) as ReadableStream<Uint8Array>;

    // Byte streams → typed ACP message streams
    let stream = createNdJsonMessageStream(output, input, {
      ignoreLine: this.ignoreLine,
    });

    // Optional message observer
    if (this.handlers.onMessage) {
      const onMessage = this.handlers.onMessage;
      stream = createTappedStream(stream, onMessage);
    }

    // Create SDK connection with client-side handlers
    this.sdkConnection = new ClientSideConnection(
      () => ({
        sessionUpdate: async (params: SessionNotification) => {
          // Reset prompt timeout on streaming updates
          this.promptTimer?.reset();
          // Update cached configOptions from config_option_update
          this.handleConfigOptionUpdate(params);
          this.handlers.onSessionUpdate(params);
        },
        requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
          // Pause prompt timeout during permission dialog
          this.promptTimer?.pause();
          try {
            return await this.handlers.onPermissionRequest(params);
          } finally {
            this.promptTimer?.resume();
          }
        },
        readTextFile: this.handlers.onReadTextFile,
        writeTextFile: this.handlers.onWriteTextFile,
      }),
      stream
    );

    // Listen for connection close
    this.sdkConnection.signal.addEventListener('abort', () => {
      this.handlers.onDisconnect?.();
    });
  }

  /**
   * Initialize the ACP protocol (must be called after setup, before session ops).
   */
  async initialize(): Promise<InitializeResponse> {
    const conn = this.requireConnection();
    const response = await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: !!this.handlers.onReadTextFile,
          writeTextFile: !!this.handlers.onWriteTextFile,
        },
      },
    });
    this.initializeResponse = response;
    return response;
  }

  /**
   * Gracefully disconnect: close session → end stdin → SIGTERM → SIGKILL.
   */
  async disconnect(): Promise<void> {
    this.promptTimer?.cancel();
    this.promptTimer = null;

    if (this.sdkConnection && this.sessionId) {
      try {
        await this.withTimeout(this.sdkConnection.unstable_closeSession({ sessionId: this.sessionId }), 5000);
      } catch {
        // Best effort — session/close is not required by spec
      }
    }

    this.sessionId = null;
    this.configOptions = null;
    this.models = null;
    this.initializeResponse = null;
    this.sdkConnection = null;

    // Child process cleanup is caller's responsibility (killChild in utils)
  }

  // =========================================================================
  // Session operations
  // =========================================================================

  async newSession(
    cwd: string,
    options?: { resumeSessionId?: string; forkSession?: boolean; mcpServers?: AcpSessionMcpServer[] }
  ): Promise<NewSessionResponse & { sessionId?: string }> {
    const conn = this.requireConnection();
    const normalizedCwd = this.normalizeCwdForAgent(cwd);

    // Build _meta for Claude/CodeBuddy resume
    const useMetaResume = (this.backend === 'claude' || this.backend === 'codebuddy') && options?.resumeSessionId;
    const meta = useMetaResume ? { claudeCode: { options: { resume: options!.resumeSessionId } } } : undefined;

    const params: Record<string, unknown> = {
      cwd: normalizedCwd,
      mcpServers: options?.mcpServers ?? [],
      ...(meta && { _meta: meta }),
      ...(this.backend !== 'claude' &&
        this.backend !== 'codebuddy' &&
        options?.resumeSessionId && { resumeSessionId: options.resumeSessionId }),
      ...(options?.forkSession && { forkSession: options.forkSession }),
    };

    const response = await conn.newSession(params as any);
    this.sessionId = (response as any).sessionId ?? null;
    this.parseSessionCapabilities(response);
    return response as NewSessionResponse & { sessionId?: string };
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    mcpServers?: AcpSessionMcpServer[]
  ): Promise<LoadSessionResponse & { sessionId?: string }> {
    const conn = this.requireConnection();
    const normalizedCwd = this.normalizeCwdForAgent(cwd);

    const response = await conn.loadSession({
      sessionId,
      cwd: normalizedCwd,
      mcpServers: (mcpServers ?? []) as any,
    });

    this.sessionId = (response as any).sessionId || sessionId;
    this.parseSessionCapabilities(response);
    return response as LoadSessionResponse & { sessionId?: string };
  }

  async authenticate(methodId?: string): Promise<void> {
    const conn = this.requireConnection();
    await conn.authenticate({ methodId: methodId ?? '' });
  }

  // =========================================================================
  // Prompt with timeout
  // =========================================================================

  /**
   * Send a prompt with automatic timeout management.
   * The timer pauses on permission requests and resets on streaming updates.
   */
  async sendPrompt(prompt: string): Promise<PromptResponse> {
    const conn = this.requireConnection();
    if (!this.sessionId) throw new Error('No active ACP session');

    this.promptTimer?.cancel();
    this.promptTimer = new ResettableTimer(this.promptTimeoutMs);

    const promptPromise = conn.prompt({
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text: prompt }],
    });

    const timeoutPromise = this.promptTimer.expired.then(() => {
      // Cancel the agent's generation
      conn.cancel({ sessionId: this.sessionId! }).catch(() => {});
      throw new TimeoutError(`LLM request timed out after ${this.promptTimeoutMs / 1000} seconds`);
    });

    try {
      return await Promise.race([promptPromise, timeoutPromise]);
    } finally {
      this.promptTimer?.cancel();
      this.promptTimer = null;
    }
  }

  /** Cancel the current prompt (best-effort, does not throw). */
  cancelPrompt(): void {
    if (!this.sdkConnection || !this.sessionId) return;
    this.promptTimer?.cancel();
    this.promptTimer = null;
    this.sdkConnection.cancel({ sessionId: this.sessionId }).catch(() => {});
  }

  // =========================================================================
  // Session configuration
  // =========================================================================

  async setSessionMode(modeId: string): Promise<void> {
    const conn = this.requireConnection();
    if (!this.sessionId) throw new Error('No active ACP session');
    await conn.setSessionMode({ sessionId: this.sessionId, modeId });
  }

  async setModel(modelId: string): Promise<void> {
    const conn = this.requireConnection();
    if (!this.sessionId) throw new Error('No active ACP session');

    await conn.unstable_setSessionModel({ sessionId: this.sessionId, modelId });

    // Eagerly update caches
    if (this.models) {
      this.models = { ...this.models, currentModelId: modelId };
    }
    if (this.configOptions) {
      this.configOptions = this.configOptions.map((opt) =>
        opt.category === ('model' satisfies SessionConfigOptionCategory) ? { ...opt, currentValue: modelId, selectedValue: modelId } : opt
      );
    }
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    const conn = this.requireConnection();
    if (!this.sessionId) throw new Error('No active ACP session');

    const response = await conn.setSessionConfigOption({
      sessionId: this.sessionId,
      configId,
      value,
    });

    // Update cache from response or optimistically
    const result = response as unknown as Record<string, unknown>;
    if (Array.isArray(result.configOptions)) {
      this.configOptions = result.configOptions as AcpSessionConfigOption[];
    } else if (this.configOptions) {
      this.configOptions = this.configOptions.map((opt) =>
        opt.id === configId ? { ...opt, currentValue: value, selectedValue: value } : opt
      );
    }
  }

  // =========================================================================
  // State queries
  // =========================================================================

  get isConnected(): boolean {
    return this.child !== null && isChildProcessRunning(this.child) && this.sdkConnection !== null;
  }

  get hasActiveSession(): boolean {
    return this.sessionId !== null;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get currentBackend(): AcpBackend {
    return this.backend;
  }

  getInitializeResponse(): InitializeResponse | null {
    return this.initializeResponse;
  }

  getConfigOptions(): AcpSessionConfigOption[] | null {
    return this.configOptions;
  }

  getModels(): AcpSessionModels | null {
    return this.models;
  }

  setPromptTimeout(ms: number): void {
    this.promptTimeoutMs = ms;
  }

  // =========================================================================
  // Internal helpers
  // =========================================================================

  private requireConnection(): ClientSideConnection {
    if (!this.sdkConnection) {
      throw new Error('AcpConnection not set up — call setup(child) first');
    }
    return this.sdkConnection;
  }

  private parseSessionCapabilities(response: unknown): void {
    const result = response as Record<string, unknown>;
    if (Array.isArray(result.configOptions)) {
      this.configOptions = result.configOptions as AcpSessionConfigOption[];
    }
    const modelsSource = result.models || (result._meta as Record<string, unknown> | undefined)?.models;
    if (modelsSource && typeof modelsSource === 'object') {
      this.models = modelsSource as AcpSessionModels;
    }
  }

  private handleConfigOptionUpdate(params: SessionNotification): void {
    if (params.update.sessionUpdate === 'config_option_update') {
      const payload = params.update as unknown as { configOptions?: AcpSessionConfigOption[] };
      if (Array.isArray(payload.configOptions)) {
        this.configOptions = payload.configOptions;
      }
    }
  }

  /**
   * Normalize cwd for agent-specific quirks:
   * - Copilot/Codex require absolute paths
   * - Others prefer relative paths (to avoid "nested" path issues)
   */
  private normalizeCwdForAgent(cwd?: string): string {
    if (!cwd) return '.';
    if (this.backend === 'copilot' || this.backend === 'codex') {
      return path.resolve(cwd);
    }
    try {
      const workspaceRoot = path.resolve(this.workingDir);
      const requested = path.resolve(cwd);
      const relative = path.relative(workspaceRoot, requested);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return relative.length === 0 ? '.' : relative;
      }
    } catch {
      // fallthrough
    }
    return '.';
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms)),
    ]);
  }
}

// ---------------------------------------------------------------------------
// TimeoutError
// ---------------------------------------------------------------------------

export class TimeoutError extends Error {
  override name = 'TimeoutError';
}
