import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputDirectory = path.join(projectRoot, 'release', 'artifacts');
const packageMetadata = JSON.parse(
  await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8')
);
const platform = process.argv[2];
const platformContract = {
  win: { metadata: 'latest.yml', extension: '.exe' },
  mac: { metadata: 'latest-mac.yml', extension: '.zip' },
  linux: { metadata: 'latest-linux.yml', extension: '.deb' },
}[platform];

if (!platformContract) {
  throw new Error('Usage: node scripts/verify-update-artifacts.mjs <win|mac|linux>');
}

const metadataPath = path.join(outputDirectory, platformContract.metadata);
const document = yaml.load(await fs.readFile(metadataPath, 'utf8'));
if (!document || typeof document !== 'object' || Array.isArray(document)) {
  throw new Error(`Update metadata must be an object: ${metadataPath}`);
}
if (document.version !== packageMetadata.version) {
  throw new Error(
    `${platformContract.metadata} version ${document.version ?? 'missing'} does not match ${packageMetadata.version}`
  );
}
if (!Array.isArray(document.files) || document.files.length === 0) {
  throw new Error(`${platformContract.metadata} must contain at least one update file`);
}

const referencedFiles = [];
for (const file of document.files) {
  if (!file || typeof file !== 'object' || typeof file.url !== 'string') {
    throw new Error(`${platformContract.metadata} contains an invalid file entry`);
  }
  if (typeof file.sha512 !== 'string' || file.sha512.length < 80) {
    throw new Error(`${platformContract.metadata} contains an invalid SHA-512 digest`);
  }
  const fileName = decodeURIComponent(path.posix.basename(file.url.split(/[?#]/, 1)[0]));
  if (!fileName || fileName === '.' || fileName === '..') {
    throw new Error(`${platformContract.metadata} contains an invalid artifact path`);
  }
  const artifactPath = path.join(outputDirectory, fileName);
  const stats = await fs.stat(artifactPath).catch(() => undefined);
  if (!stats?.isFile() || stats.size === 0) {
    throw new Error(`Referenced update artifact is missing or empty: ${artifactPath}`);
  }
  referencedFiles.push(fileName);
}

if (!referencedFiles.some((fileName) => fileName.toLowerCase().endsWith(platformContract.extension))) {
  throw new Error(
    `${platformContract.metadata} does not reference a ${platformContract.extension} update target`
  );
}

console.log(
  `Update metadata verified: ${platformContract.metadata} -> ${referencedFiles.join(', ')}`
);
