function absoluteRoot(path: string): string | undefined {
  return /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)|\/)/.exec(path)?.[0];
}

/** Resolve renderer file paths using an explicit directory, in that directory's path syntax. */
export function resolveLocalPath(path: string, baseDirectory?: string): string | null {
  if (absoluteRoot(path)) return path;
  const root = baseDirectory && absoluteRoot(baseDirectory);
  if (!root || !baseDirectory) return null;
  const windows = /^[A-Za-z]:|^[\\/]{2}/.test(root);
  const separator = windows && root.includes('\\') ? '\\' : '/';
  const split = windows ? /[\\/]+/ : /\/+/;
  const segments: string[] = [];
  for (const segment of `${baseDirectory.slice(root.length)}${separator}${path}`.split(split)) {
    if (segment === '..') segments.pop();
    else if (segment && segment !== '.') segments.push(segment);
  }
  const prefix = root.endsWith(separator) ? root : `${root}${separator}`;
  return prefix + segments.join(separator);
}

export function localPathDirectory(path: string): string | undefined {
  return resolveLocalPath('..', path) ?? undefined;
}
