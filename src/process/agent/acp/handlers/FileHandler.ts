import { promises as fs } from 'fs';
import * as path from 'path';
import { CLIENT_METHODS } from '@agentclientprotocol/sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FileOperationMethod =
  | typeof CLIENT_METHODS.fs_read_text_file
  | typeof CLIENT_METHODS.fs_write_text_file;

export type FileOperationEvent = {
  method: FileOperationMethod;
  path: string;
  content?: string;
  sessionId: string;
};

export type FileOperationCallback = (operation: FileOperationEvent) => void;

export type FileStreamUpdateEmitter = (update: {
  filePath: string;
  content: string;
  workspace: string;
  relativePath: string;
  operation: 'write';
}) => void;

// ---------------------------------------------------------------------------
// FileHandler
// ---------------------------------------------------------------------------

/**
 * Handles `fs/read_text_file` and `fs/write_text_file` requests from the
 * ACP agent. Resolves paths relative to the session workspace and notifies
 * the UI via callbacks.
 *
 * Extracted from AcpConnection.handleReadOperation / handleWriteOperation.
 */
export class FileHandler {
  constructor(
    private workingDir: string,
    private onFileOperation?: FileOperationCallback,
    private emitFileStreamUpdate?: FileStreamUpdateEmitter
  ) {}

  updateWorkingDir(dir: string): void {
    this.workingDir = dir;
  }

  async readTextFile(params: { path: string; sessionId?: string }): Promise<{ content: string }> {
    const resolved = this.resolveWorkspacePath(params.path);
    this.onFileOperation?.({
      method: CLIENT_METHODS.fs_read_text_file,
      path: resolved,
      sessionId: params.sessionId || '',
    });
    try {
      const content = await fs.readFile(resolved, 'utf-8');
      return { content };
    } catch (error) {
      throw new Error(`Failed to read file: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }

  async writeTextFile(params: { path: string; content: string; sessionId?: string }): Promise<null> {
    const resolved = this.resolveWorkspacePath(params.path);
    this.onFileOperation?.({
      method: CLIENT_METHODS.fs_write_text_file,
      path: resolved,
      content: params.content,
      sessionId: params.sessionId || '',
    });
    try {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, params.content, 'utf-8');

      this.emitFileStreamUpdate?.({
        filePath: resolved,
        content: params.content,
        workspace: path.dirname(resolved),
        relativePath: path.basename(resolved),
        operation: 'write',
      });

      return null;
    } catch (error) {
      throw new Error(`Failed to write file: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }

  /**
   * Resolve a file path relative to the session workspace.
   * Absolute paths pass through unchanged; relative paths are joined with workingDir.
   */
  private resolveWorkspacePath(targetPath: string): string {
    if (!targetPath) return this.workingDir;
    if (path.isAbsolute(targetPath)) return targetPath;
    return path.join(this.workingDir, targetPath);
  }
}
