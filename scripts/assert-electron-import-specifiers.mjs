import fs from 'node:fs';
import path from 'node:path';

const outputRoot = path.resolve('dist-electron');
const emittedExtensions = ['.js', '.mjs', '.cjs', '.d.ts'];
const unresolvedAliasPattern = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"](@(?:electron|shared)\/[^'"]+)['"]/g;

function collectEmittedFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectEmittedFiles(entryPath);
    return emittedExtensions.some((extension) => entry.name.endsWith(extension))
      ? [entryPath]
      : [];
  });
}

const unresolvedAliases = [];
for (const filePath of collectEmittedFiles(outputRoot)) {
  const source = fs.readFileSync(filePath, 'utf8');
  for (const match of source.matchAll(unresolvedAliasPattern)) {
    unresolvedAliases.push(`${path.relative(outputRoot, filePath)}: ${match[1]}`);
  }
}

if (unresolvedAliases.length > 0) {
  throw new Error(`Electron build contains unresolved path aliases:\n${unresolvedAliases.join('\n')}`);
}

const electronEntrypoints = [
  path.join(outputRoot, 'electron/bootstrap.js'),
  path.join(outputRoot, 'electron/preload.js'),
];
const bareElectronImportPattern = /\bfrom\s*['"]electron['"]|\bimport\s*\(\s*['"]electron['"]\s*\)/;

for (const filePath of electronEntrypoints) {
  const source = fs.readFileSync(filePath, 'utf8');
  if (!bareElectronImportPattern.test(source)) {
    throw new Error(
      `${path.relative(outputRoot, filePath)} must preserve its bare 'electron' package import`
    );
  }
}
