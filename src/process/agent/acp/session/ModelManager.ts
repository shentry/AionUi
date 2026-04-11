import type { AcpModelInfo, AcpSessionConfigOption, AcpSessionModels } from '@/common/types/acpTypes';
import type { SessionConfigOptionCategory } from '@agentclientprotocol/sdk';
import { buildAcpModelInfo } from '../config/modelInfo';

const MODEL_CATEGORY: SessionConfigOptionCategory = 'model';
const MODE_CATEGORY: SessionConfigOptionCategory = 'mode';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The ACP connection methods that ModelManager needs. */
export interface ModelManagerConnection {
  setModel(modelId: string): Promise<void>;
  setConfigOption(configId: string, value: string): Promise<void>;
  getConfigOptions(): AcpSessionConfigOption[] | null;
  getModels(): AcpSessionModels | null;
}

// ---------------------------------------------------------------------------
// ModelManager
// ---------------------------------------------------------------------------

/**
 * Manages model selection, config options, and model info.
 *
 * Tracks user model overrides and queues "model switch notices" to be
 * injected into the next prompt (so the AI knows its identity changed).
 *
 * Extracted from AcpAgent.setModelByConfigOption / getModelInfo / getConfigOptions / emitModelInfo.
 */
export class ModelManager {
  /**
   * When the user explicitly switches models, this is set so that subsequent
   * prompts can re-assert the model if the backend silently drifts back.
   */
  private _userOverride: string | null = null;

  /**
   * Queued model switch notice to inject into the next user prompt.
   * Consumed (and cleared) by the message sender.
   */
  private _pendingSwitchNotice: string | null = null;

  /** User-selected model override (null if no explicit switch). */
  get userOverride(): string | null {
    return this._userOverride;
  }

  /** Consume the pending model switch notice (returns null if none). */
  consumeSwitchNotice(): string | null {
    const notice = this._pendingSwitchNotice;
    this._pendingSwitchNotice = null;
    return notice;
  }

  /** Build unified model info from connection's configOptions and models. */
  getModelInfo(connection: ModelManagerConnection): AcpModelInfo | null {
    return buildAcpModelInfo(connection.getConfigOptions(), connection.getModels());
  }

  /**
   * Get non-model, non-mode config options (reasoning effort, output format, etc.).
   * Filters out model-category and mode-category options.
   */
  getConfigOptions(connection: ModelManagerConnection): AcpSessionConfigOption[] {
    const all = connection.getConfigOptions();
    if (!all) return [];
    return all.filter((opt) => opt.category !== MODEL_CATEGORY && opt.category !== MODE_CATEGORY);
  }

  /** Set a config option value (e.g. reasoning effort). */
  async setConfigOption(
    connection: ModelManagerConnection,
    configId: string,
    value: string
  ): Promise<AcpSessionConfigOption[]> {
    await connection.setConfigOption(configId, value);
    return this.getConfigOptions(connection);
  }

  /**
   * Switch model via session/set_model (preferred), falling back to
   * session/set_config_option for backends that don't support set_model.
   */
  async setModel(connection: ModelManagerConnection, modelId: string): Promise<AcpModelInfo | null> {
    const modelInfo = this.getModelInfo(connection);
    if (!modelInfo) {
      throw new Error('No model info available');
    }

    try {
      await connection.setModel(modelId);
    } catch (setModelError) {
      // Fallback to set_config_option for non-Claude backends
      if (modelInfo.source === 'configOption' && modelInfo.configOptionId) {
        await connection.setConfigOption(modelInfo.configOptionId, modelId);
      } else {
        throw setModelError;
      }
    }

    this._userOverride = modelId;
    this._pendingSwitchNotice = modelId;

    return this.getModelInfo(connection);
  }

  /**
   * Re-assert the user model override if the backend's current model drifted.
   * Called before sending each prompt.
   */
  async reassertModelIfNeeded(connection: ModelManagerConnection): Promise<void> {
    if (!this._userOverride) return;
    const info = this.getModelInfo(connection);
    if (info && info.currentModelId !== this._userOverride) {
      try {
        await connection.setModel(this._userOverride);
      } catch {
        // Best effort — don't block the prompt
      }
    }
  }

  /** Reset state (e.g. on disconnect). */
  reset(): void {
    this._userOverride = null;
    this._pendingSwitchNotice = null;
  }
}
