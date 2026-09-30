import fs from 'node:fs';
import path from 'node:path';
import { PublicOperationError } from '../../capabilities/public-errors.js';
import { expandHomePath } from '../../utils/expand-home-path.js';

const CHANGE_DEBOUNCE_MS = 300;

type PreviewPath = {
  readonly path: string;
  readonly revision: string;
} & ({ readonly kind: 'file'; readonly size: number } | { readonly kind: 'directory' });

interface WatchLocation {
  readonly directory: string;
  readonly basename: string;
  readonly identity: string;
}

interface Subscriber {
  readonly listener: (revision: string | null) => void;
  readonly onError?: (error: unknown) => void;
  readonly dispose: () => void;
  ready: boolean;
}

interface PathWatch {
  readonly path: string;
  readonly subscribers: Set<Subscriber>;
  readonly locations: Map<string, WatchLocation>;
  revision: string | null | undefined;
  ready?: Promise<void>;
  refreshing?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  pendingRefresh: boolean;
  closed: boolean;
  error?: unknown;
}

interface DirectoryWatch {
  readonly watcher: fs.FSWatcher;
  readonly targets: Map<string, Set<PathWatch>>;
  readonly identity: string;
}

export async function resolvePreviewPath(targetPath: string): Promise<PreviewPath> {
  const absolute = absolutePreviewPath(targetPath);
  let file: PreviewPath | null;
  try {
    file = await inspectPreviewPath(absolute);
  } catch (error) {
    if (error instanceof PublicOperationError && error.code === 'invalid-input') throw error;
    // Keep the existing preview error contract; metadata observation reports access failures separately.
    throw new PublicOperationError('not-found', 'The requested path does not exist');
  }
  if (!file) throw new PublicOperationError('not-found', 'The requested path does not exist');
  return file;
}

export async function readFileRevision(targetPath: string, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  const file = await inspectPreviewPath(absolutePreviewPath(targetPath));
  signal?.throwIfAborted();
  return file?.revision ?? null;
}

export class FilePreviewWatcher {
  private readonly paths = new Map<string, PathWatch>();
  private readonly directories = new Map<string, DirectoryWatch>();

  async observe(
    targetPath: string,
    listener: (revision: string | null) => void,
    signal?: AbortSignal,
    onError?: (error: unknown) => void,
  ): Promise<{ snapshot: string | null; dispose: () => void }> {
    signal?.throwIfAborted();
    const absolute = absolutePreviewPath(targetPath);
    let state = this.paths.get(absolute);
    if (!state) {
      state = { path: absolute, subscribers: new Set(), locations: new Map(), revision: undefined, pendingRefresh: false, closed: false };
      this.paths.set(absolute, state);
    }
    const watched = state;
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      signal?.removeEventListener('abort', dispose);
      watched.subscribers.delete(subscriber);
      if (watched.subscribers.size === 0) this.close(watched);
    };
    const subscriber: Subscriber = { listener, onError, dispose, ready: false };
    watched.subscribers.add(subscriber);
    signal?.addEventListener('abort', dispose, { once: true });
    watched.ready ??= this.refresh(watched).catch((error: unknown) => {
      this.fail(watched, error);
      throw error;
    });
    try {
      await watched.ready;
      signal?.throwIfAborted();
      if (watched.closed) throw watched.error;
      subscriber.ready = true;
      return { snapshot: watched.revision ?? null, dispose };
    } catch (error) {
      dispose();
      throw error;
    }
  }

  private refresh(state: PathWatch): Promise<void> {
    if (state.refreshing) return state.refreshing;
    const pending = this.inspect(state).finally(() => {
      state.refreshing = undefined;
      if (state.pendingRefresh) {
        state.pendingRefresh = false;
        this.schedule(state);
      }
    });
    state.refreshing = pending;
    return pending;
  }

  private async inspect(state: PathWatch): Promise<void> {
    let file: PreviewPath | null;
    for (;;) {
      const locations = await watchLocations(state.path);
      if (state.closed) return;
      try {
        this.rebind(state, locations);
      } catch (error) {
        if (!isMissing(error)) throw error;
        // A directory can disappear after resolution but before watch allocation.
        continue;
      }
      // The token is captured only after the relevant directory watches are installed.
      file = await inspectPreviewPath(state.path);
      if (state.closed) return;
      if (!file || state.locations.has(locationKey({
        directory: path.dirname(file.path), basename: path.basename(file.path),
      }))) break;
    }
    const revision = file?.revision ?? null;
    const previous = state.revision;
    state.revision = revision;
    if (previous === undefined || previous === revision) return;
    for (const subscriber of state.subscribers) {
      if (subscriber.ready) subscriber.listener(revision);
    }
  }

  private schedule(state: PathWatch): void {
    if (state.closed) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (state.closed) return;
      if (state.refreshing) {
        state.pendingRefresh = true;
        return;
      }
      void this.refresh(state).catch((error: unknown) => this.fail(state, error));
    }, CHANGE_DEBOUNCE_MS);
  }

  private rebind(state: PathWatch, locations: Map<string, WatchLocation>): void {
    for (const [key, location] of locations) {
      const directory = this.directoryWatch(location);
      if (state.locations.has(key)) {
        state.locations.set(key, location);
        continue;
      }
      let targets = directory.targets.get(location.basename);
      if (!targets) {
        targets = new Set();
        directory.targets.set(location.basename, targets);
      }
      targets.add(state);
      state.locations.set(key, location);
    }
    for (const [key, location] of state.locations) {
      if (locations.has(key)) continue;
      this.release(state, location);
      state.locations.delete(key);
    }
  }

  private directoryWatch(location: WatchLocation): DirectoryWatch {
    const previous = this.directories.get(location.directory);
    if (previous?.identity === location.identity) return previous;
    const targets = previous?.targets ?? new Map<string, Set<PathWatch>>();
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(location.directory, { recursive: false }, (event, filename) => {
        if (this.directories.get(location.directory)?.watcher !== watcher) return;
        const name = filename?.toString();
        const changed = name === undefined || (event === 'rename' && name === path.basename(location.directory))
          ? new Set([...targets.values()].flatMap((states) => [...states]))
          : targets.get(name);
        for (const target of changed ?? []) this.schedule(target);
      });
    } catch (error) {
      if (isMissing(error)) throw error;
      const failure = fileAccessError(error, 'The requested path could not be watched');
      for (const target of new Set([...targets.values()].flatMap((states) => [...states]))) this.fail(target, failure);
      throw failure;
    }
    const directory = { watcher, targets, identity: location.identity };
    watcher.on('error', (error) => {
      if (this.directories.get(location.directory) !== directory) return;
      const affected = new Set([...targets.values()].flatMap((states) => [...states]));
      for (const target of affected) this.fail(target, fileAccessError(error, 'The requested path could not be watched'));
    });
    // A pathname can now name a different inode; migrate every shared target to the new handle.
    this.directories.set(location.directory, directory);
    previous?.watcher.close();
    return directory;
  }

  private release(state: PathWatch, location: WatchLocation): void {
    const directory = this.directories.get(location.directory)!;
    const targets = directory.targets.get(location.basename)!;
    targets.delete(state);
    if (targets.size === 0) directory.targets.delete(location.basename);
    if (directory.targets.size === 0) {
      this.directories.delete(location.directory);
      directory.watcher.close();
    }
  }

  private close(state: PathWatch): void {
    if (state.closed) return;
    state.closed = true;
    this.paths.delete(state.path);
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    for (const location of state.locations.values()) this.release(state, location);
    state.locations.clear();
  }

  private fail(state: PathWatch, error: unknown): void {
    if (state.closed) return;
    state.error = error;
    this.close(state);
    for (const subscriber of [...state.subscribers]) {
      subscriber.dispose();
      if (subscriber.ready) subscriber.onError?.(error);
    }
  }
}

function absolutePreviewPath(targetPath: string): string {
  const expanded = expandHomePath(targetPath);
  if (!path.isAbsolute(expanded)) {
    throw new PublicOperationError('invalid-input', 'An absolute path is required');
  }
  // The filesystem must follow a symlink before resolving any subsequent dotdot component.
  return expanded;
}

async function inspectPreviewPath(absolute: string): Promise<PreviewPath | null> {
  let resolved: string;
  let stats: fs.BigIntStats;
  try {
    resolved = await fs.promises.realpath(absolute);
    stats = await fs.promises.stat(resolved, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return null;
    throw fileAccessError(error, 'The requested path could not be inspected');
  }
  const revision = [stats.dev, stats.ino, stats.mode, stats.nlink, stats.size,
    stats.mtimeNs, stats.ctimeNs, stats.birthtimeNs].join(':');
  if (stats.isFile()) return { kind: 'file', path: resolved, size: Number(stats.size), revision };
  if (stats.isDirectory()) return { kind: 'directory', path: resolved, revision };
  throw new PublicOperationError('invalid-input', 'A regular file or directory is required');
}

async function watchLocations(absolute: string): Promise<Map<string, WatchLocation>> {
  const locations = new Map<string, WatchLocation>();
  const visited = new Set<string>();
  const add = async (target: string): Promise<void> => {
    for (;;) {
      const parent = path.dirname(target);
      try {
        const directory = await fs.promises.realpath(parent);
        const stats = await fs.promises.lstat(directory, { bigint: true });
        if (stats.isDirectory()) {
          const location = { directory, basename: path.basename(target), identity: `${stats.dev}:${stats.ino}` };
          locations.set(locationKey(location), location);
          return;
        }
      } catch (error) {
        if (!isMissing(error) || parent === target) throw error;
      }
      // Missing parents are recoverable: watch the first absent entry in its nearest existing ancestor.
      target = parent;
    }
  };
  const visit = async (target: string): Promise<void> => {
    if (visited.has(target)) return;
    visited.add(target);
    const root = path.parse(target).root;
    const components = target.slice(root.length).split(path.sep).filter(Boolean);
    let prefix = root;
    for (const [index, component] of components.entries()) {
      prefix = path.join(prefix, component);
      let stats: fs.Stats;
      try {
        stats = await fs.promises.lstat(prefix);
      } catch (error) {
        if (!isMissing(error)) throw error;
        await add(prefix);
        return;
      }
      if (!stats.isSymbolicLink()) {
        if (!stats.isDirectory() && index < components.length - 1) {
          await add(prefix);
          return;
        }
        continue;
      }
      await add(prefix);
      let link: string;
      try {
        link = await fs.promises.readlink(prefix);
      } catch (error) {
        // A link can be removed or replaced by a regular file while resolving it.
        if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'EINVAL') continue;
        throw error;
      }
      const destination = path.isAbsolute(link) ? link : `${path.dirname(prefix)}${path.sep}${link}`;
      const remaining = components.slice(index + 1);
      await visit(remaining.length ? `${destination}${path.sep}${remaining.join(path.sep)}` : destination);
      return;
    }
    await add(prefix);
  };
  try {
    // Let the filesystem reject actual symlink loops before following missing targets.
    await fs.promises.realpath(absolute).catch((error: unknown) => { if (!isMissing(error)) throw error; });
    await visit(absolute);
  } catch (error) {
    throw fileAccessError(error, 'The requested path could not be watched');
  }
  return locations;
}

function locationKey(location: Pick<WatchLocation, 'directory' | 'basename'>): string {
  return JSON.stringify([location.directory, location.basename]);
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function fileAccessError(error: unknown, message: string): PublicOperationError {
  const code = (error as NodeJS.ErrnoException).code;
  return new PublicOperationError(code === 'EACCES' || code === 'EPERM' ? 'forbidden' : 'unavailable', message);
}
