import fs from 'node:fs';

const preloadPath = 'dist-electron/electron/preload.cjs';
const source = fs.readFileSync(preloadPath, 'utf8');
const unsupportedRequires = [...source.matchAll(/require\(["'](node:[^"']+)["']\)/g)].map(
  (match) => match[1]
);

if (unsupportedRequires.length > 0) {
  throw new Error(
    `Sandboxed preload contains unsupported Node imports: ${[...new Set(unsupportedRequires)].join(
      ', '
    )}`
  );
}
