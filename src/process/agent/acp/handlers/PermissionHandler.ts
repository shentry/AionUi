import { uuid } from '@/common/utils';
import type { AcpPermissionRequest } from '@/common/types/acpTypes';
import type { PermissionOptionKind } from '@agentclientprotocol/sdk';
import { AcpApprovalStore, createAcpApprovalKey } from '../ApprovalStore';

const ALLOW_ALWAYS: PermissionOptionKind = 'allow_always';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PermissionRequestMeta = {
  kind: string;
  title: string;
  rawInput?: Record<string, unknown>;
};

export type PermissionEmitCallback = (data: AcpPermissionRequest) => void;

export type PermissionHandlerOptions = {
  /** Emit the permission request to the UI. */
  onEmit: PermissionEmitCallback;
  /** Whether the session is in team mode (infinite timeout). */
  isTeamMode?: boolean;
  /** Standalone permission timeout in ms (default 30 min). */
  standaloneTimeoutMs?: number;
};

// ---------------------------------------------------------------------------
// PermissionHandler
// ---------------------------------------------------------------------------

/**
 * Manages ACP permission request lifecycle:
 * - Caches "always allow" decisions via ApprovalStore
 * - Tracks pending requests (resolve/reject) until UI confirmation
 * - Stores metadata for building approval keys on confirm
 * - Auto-rejects after timeout in standalone mode
 *
 * Extracted from AcpAgent.handlePermissionRequest / confirmMessage.
 */
export class PermissionHandler {
  private readonly approvalStore = new AcpApprovalStore();
  private readonly pendingPermissions = new Map<
    string,
    { resolve: (value: { optionId: string }) => void; reject: (error: Error) => void }
  >();
  private readonly requestMeta = new Map<string, PermissionRequestMeta>();
  private readonly options: Required<PermissionHandlerOptions>;

  constructor(options: PermissionHandlerOptions) {
    this.options = {
      isTeamMode: false,
      standaloneTimeoutMs: 1800000, // 30 min
      ...options,
    };
  }

  /**
   * Handle an incoming permission request from the agent.
   * Returns a promise that resolves when the user confirms/denies.
   */
  handle(data: AcpPermissionRequest): Promise<{ optionId: string }> {
    return new Promise((resolve, reject) => {
      // Ensure stable toolCallId
      if (data.toolCall && !data.toolCall.toolCallId) {
        data.toolCall.toolCallId = uuid();
      }
      const requestId = data.toolCall.toolCallId;

      // Check cached "always allow"
      const approvalKey = createAcpApprovalKey(data.toolCall);
      if (this.approvalStore.isApprovedForSession(approvalKey)) {
        resolve({ optionId: ALLOW_ALWAYS });
        return;
      }

      // Store metadata for later use in confirm()
      this.requestMeta.delete(requestId);
      this.requestMeta.set(requestId, {
        kind: data.toolCall.kind,
        title: data.toolCall.title,
        rawInput: data.toolCall.rawInput,
      });

      // Replace duplicate pending request
      const existing = this.pendingPermissions.get(requestId);
      if (existing) {
        existing.reject(new Error('Replaced by new permission request'));
        this.pendingPermissions.delete(requestId);
      }

      this.pendingPermissions.set(requestId, { resolve, reject });

      // Emit to UI
      try {
        this.options.onEmit(data);
      } catch (error) {
        this.pendingPermissions.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      // Timeout (standalone mode only — team mode waits indefinitely)
      if (!this.options.isTeamMode) {
        setTimeout(() => {
          if (this.pendingPermissions.has(requestId)) {
            this.pendingPermissions.delete(requestId);
            reject(new Error('Permission request timed out'));
          }
        }, this.options.standaloneTimeoutMs);
      }
    });
  }

  /**
   * Confirm or deny a pending permission request (called from the UI).
   *
   * @returns true if the request was found and resolved, false otherwise.
   */
  confirm(callId: string, optionId: string): boolean {
    const pending = this.pendingPermissions.get(callId);
    if (!pending) return false;

    this.pendingPermissions.delete(callId);

    // Cache "always allow" decisions
    if (optionId === ALLOW_ALWAYS) {
      const meta = this.requestMeta.get(callId);
      if (meta) {
        this.approvalStore.put(
          createAcpApprovalKey({ kind: meta.kind, title: meta.title, rawInput: meta.rawInput }),
          ALLOW_ALWAYS
        );
      }
    }

    this.requestMeta.delete(callId);
    pending.resolve({ optionId });
    return true;
  }

  /** Reject all pending permission requests (e.g. on disconnect). */
  cancelAll(reason = 'Session disconnected'): void {
    for (const [id, { reject }] of this.pendingPermissions) {
      reject(new Error(reason));
      this.requestMeta.delete(id);
    }
    this.pendingPermissions.clear();
  }

  /** Clear the approval cache (e.g. on kill / new session). */
  clearApprovals(): void {
    this.approvalStore.clear();
  }

  /** Whether there are unresolved permission requests. */
  get hasPending(): boolean {
    return this.pendingPermissions.size > 0;
  }

  /** Get metadata for a pending request (used by navigation interception). */
  getRequestMeta(callId: string): PermissionRequestMeta | undefined {
    return this.requestMeta.get(callId);
  }
}
