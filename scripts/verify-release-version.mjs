import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageMetadata = JSON.parse(
  await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8')
);
const tag = process.argv[2] || process.env.GITHUB_REF_NAME;

if (!tag) {
  throw new Error('Pass a release tag such as v0.1.0 or set GITHUB_REF_NAME');
}
if (!/^(?:v)(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) {
  throw new Error(`Release tag must be a stable vMAJOR.MINOR.PATCH tag: ${tag}`);
}
if (tag !== `v${packageMetadata.version}`) {
  throw new Error(`Release tag ${tag} does not match package version v${packageMetadata.version}`);
}

const repositoryUrl = typeof packageMetadata.repository === 'string'
  ? packageMetadata.repository
  : packageMetadata.repository?.url;
if (repositoryUrl !== 'https://github.com/piskie-dev/piskie.git') {
  throw new Error(`Unexpected release repository: ${repositoryUrl ?? 'missing'}`);
}

const githubPublisher = packageMetadata.build?.publish?.find?.(
  (publisher) => publisher?.provider === 'github'
);
if (githubPublisher?.owner !== 'piskie-dev' || githubPublisher?.repo !== 'piskie') {
  throw new Error('electron-builder GitHub publisher must target piskie-dev/piskie');
}
if (githubPublisher.releaseType !== 'draft') {
  throw new Error('Desktop releases must be uploaded as drafts for verification');
}

console.log(`Release version verified: ${tag}`);
