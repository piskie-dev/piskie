import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { clipboard } from 'electron';
import { PublicOperationError } from '../../capabilities/public-errors.js';

const WINDOWS_FILE_DROP_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$files = New-Object System.Collections.Specialized.StringCollection
[void]$files.Add($path)
[System.Windows.Forms.Clipboard]::SetFileDropList($files)
`;

/** Publishes a canonical file or directory path already resolved by the application. */
export async function publishFileReference(filePath: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const child = execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand',
        Buffer.from(WINDOWS_FILE_DROP_SCRIPT, 'utf16le').toString('base64'),
      ], { windowsHide: true, signal }, (error) => {
        if (error) reject(error);
        else resolve();
      });
      child.stdin!.on('error', reject);
      child.stdin!.end(Buffer.from(filePath, 'utf8').toString('base64'));
    });
    return;
  }
  const format = process.platform === 'linux' ? 'text/uri-list'
    : process.platform === 'darwin' ? 'public.file-url' : undefined;
  if (!format) throw new PublicOperationError('unavailable', 'File clipboard copying is unavailable on this platform');
  const value = Buffer.from(pathToFileURL(filePath).href + (process.platform === 'linux' ? '\r\n' : ''));
  clipboard.writeBuffer(format, value);
  if (!clipboard.readBuffer(format).equals(value)) {
    throw new PublicOperationError('unavailable', 'The system clipboard did not accept the file reference');
  }
}
