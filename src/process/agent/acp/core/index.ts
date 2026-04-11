// Types
export type { OutputErrorCode, OutputErrorOrigin, OutputErrorAcpPayload, ExitCode, ErrorClassifier } from './types';
export { OUTPUT_ERROR_CODES, OUTPUT_ERROR_ORIGINS, EXIT_CODES } from './types';

// Process utilities
export {
  isoNow,
  waitForSpawn,
  isChildProcessRunning,
  requireAgentStdio,
  waitForChildExit,
  splitCommandLine,
  asAbsoluteCwd,
  basenameToken,
} from './clientProcess';
export type { CommandParts } from './clientProcess';

// JSON-RPC message parsing
export {
  isAcpJsonRpcMessage,
  isJsonRpcNotification,
  isSessionUpdateNotification,
  extractSessionUpdateNotification,
  parsePromptStopReason,
  parseJsonRpcErrorMessage,
} from './jsonrpc';

// Error shapes — ACP error extraction
export { extractAcpError, formatUnknownErrorMessage, isAcpResourceNotFoundError } from './errorShapes';

// Error normalization
export {
  formatErrorMessage,
  isAcpQueryClosedBeforeResponseError,
  normalizeOutputError,
  isRetryablePromptError,
  exitCodeForOutputErrorCode,
} from './errorNormalization';
export type { NormalizedOutputError, NormalizeOutputErrorOptions } from './errorNormalization';

// JSON-RPC error response builder
export { OUTPUT_ERROR_JSONRPC_CODES, buildJsonRpcErrorResponse } from './errorJsonrpc';
export type { BuildJsonRpcErrorParams } from './errorJsonrpc';

// Transport — ndjson message streams
export { createNdJsonMessageStream, createTappedStream } from './transport';
export type { AcpMessageStream, NdJsonStreamOptions, MessageObserver } from './transport';

// Session control errors
export { formatSessionControlAcpSummary, maybeWrapSessionControlError } from './errorSessionControl';
export type { SessionControlMethod } from './errorSessionControl';
