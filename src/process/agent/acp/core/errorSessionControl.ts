import { AGENT_METHODS } from '@agentclientprotocol/sdk';
import { extractAcpError } from './errorShapes';

const SESSION_CONTROL_UNSUPPORTED_ACP_CODES = new Set([-32601, -32602]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isLikelySessionControlUnsupportedError(acp: { code: number; message: string; data?: unknown }): boolean {
  if (SESSION_CONTROL_UNSUPPORTED_ACP_CODES.has(acp.code)) {
    return true;
  }

  if (acp.code !== -32603) {
    return false;
  }

  const details = asRecord(acp.data)?.details;
  return typeof details === 'string' && details.toLowerCase().includes('invalid params');
}

export function formatSessionControlAcpSummary(acp: { code: number; message: string; data?: unknown }): string {
  const details = asRecord(acp.data)?.details;
  if (typeof details === 'string' && details.trim().length > 0) {
    return `${details.trim()} (ACP ${acp.code}, adapter reported "${acp.message}")`;
  }
  return `${acp.message} (ACP ${acp.code})`;
}

export type SessionControlMethod =
  | typeof AGENT_METHODS.session_set_mode
  | typeof AGENT_METHODS.session_set_config_option
  | typeof AGENT_METHODS.session_set_model;

export function maybeWrapSessionControlError(
  method: SessionControlMethod,
  error: unknown,
  context?: string
): unknown {
  const acp = extractAcpError(error);
  if (!acp || !isLikelySessionControlUnsupportedError(acp)) {
    return error;
  }

  const acpSummary = formatSessionControlAcpSummary(acp);
  const contextSuffix = context ? ` ${context}` : '';
  const message =
    `Agent rejected ${method}${contextSuffix}: ${acpSummary}. ` +
    `The adapter may not implement ${method}, or the requested value is not supported.`;
  const wrapped = new Error(message, {
    cause: error instanceof Error ? error : undefined,
  }) as Error & {
    acp?: typeof acp;
  };
  wrapped.acp = acp;
  return wrapped;
}
