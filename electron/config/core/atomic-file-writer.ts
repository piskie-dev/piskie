import { createUuid } from '@shared/utils/identifiers.js';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface AtomicFileWriter {
  replace(filePath: string, contents: string): Promise<void>;
  create(filePath: string, contents: string): Promise<boolean>;
}

/** Shared persistence boundary for canonical configs, Plans, history, and receipts. */
export class CrossPlatformAtomicFileWriter implements AtomicFileWriter {
  async replace(filePath: string, contents: string): Promise<void> {
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(
      directory,
      `.${path.basename(filePath)}.${process.pid}.${createUuid()}.tmp`,
    );

    try {
      await writeNewFile(temporaryPath, contents);
      await fs.rename(temporaryPath, filePath);
    } catch (cause) {
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw cause;
    }
  }

  async create(filePath: string, contents: string): Promise<boolean> {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    try {
      await writeNewFile(filePath, contents);
      return true;
    } catch (cause) {
      if (isNodeError(cause, 'EEXIST')) return false;
      throw cause;
    }
  }
}

export const configFileWriter: AtomicFileWriter = new CrossPlatformAtomicFileWriter();

async function writeNewFile(filePath: string, contents: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  let created = false;
  let complete = false;

  try {
    handle = await fs.open(filePath, 'wx', 0o600);
    created = true;
    await handle.writeFile(contents, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    complete = true;
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    if (created && !complete) await fs.unlink(filePath).catch(() => undefined);
    throw cause;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
