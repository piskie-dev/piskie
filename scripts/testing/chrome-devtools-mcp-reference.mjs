#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const RELEASE = Object.freeze({
  package: 'chrome-devtools-mcp',
  version: '1.7.0',
  tarballUrl:
    'https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-1.7.0.tgz',
  integrity:
    'sha512-6xFW7oiUxTxZuHcfyYBkKQtmttjCbfifKZMSEk5CV8H2FucvKweYiJr8CblddYHtYjA4C14K9VAs1r49906RBA==',
  shasum: 'b20e2ee77afb585e2e762535c37ca9336e7445a4',
  sha256: '895733586a0ece138493790c07e8b083b8571b1d2037a73124334d968d1046d0',
});
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LOCAL_LICENSE = join(
  PROJECT_ROOT,
  'electron/piskiepilot/browser/third_party/chrome-devtools-mcp-1.7.0/LICENSE'
);

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const scratch = await mkdtemp(join(tmpdir(), 'piskie-cdmcp-reference-'));
let client;
try {
  const tarball = options.tarball
    ? resolve(options.tarball)
    : await downloadTarball(join(scratch, `${RELEASE.package}-${RELEASE.version}.tgz`));
  const bytes = await readFile(tarball);
  verifyTarball(bytes);

  await run('tar', ['-xzf', tarball, '-C', scratch]);
  const packageRoot = join(scratch, 'package');
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (packageJson.name !== RELEASE.package || packageJson.version !== RELEASE.version) {
    throw new Error(
      `Unexpected package identity: ${packageJson.name}@${packageJson.version}`
    );
  }
  if (packageJson.license !== 'Apache-2.0') {
    throw new Error(`Unexpected package license: ${packageJson.license}`);
  }
  const upstreamLicense = await readFile(join(packageRoot, 'LICENSE'), 'utf8');
  const localLicense = await readFile(LOCAL_LICENSE, 'utf8');
  if (!upstreamLicense.includes('Apache License\n                           Version 2.0')) {
    throw new Error('Official package does not contain the expected Apache-2.0 LICENSE');
  }
  if (localLicense.trimEnd() !== upstreamLicense.trimEnd()) {
    throw new Error('Local Apache-2.0 LICENSE differs from the official 1.7.0 package');
  }

  const result = {
    package: `${RELEASE.package}@${RELEASE.version}`,
    integrity: RELEASE.integrity,
    shasum: RELEASE.shasum,
    sha256: RELEASE.sha256,
    license: packageJson.license,
    mode: options.wsEndpoint ? 'observe' : 'verify',
  };

  if (!options.wsEndpoint) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 0;
  } else {
    const serverEntry = join(packageRoot, 'build/src/bin/chrome-devtools-mcp.js');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        serverEntry,
        '--wsEndpoint',
        options.wsEndpoint,
        '--no-usage-statistics',
        '--no-performance-crux',
      ],
      env: referenceEnvironment(),
      stderr: 'inherit',
    });
    client = new Client(
      { name: 'piskie-chrome-devtools-mcp-reference', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    for (const required of ['list_pages', 'take_snapshot']) {
      if (!toolNames.includes(required)) {
        throw new Error(`Official reference server did not expose ${required}`);
      }
    }
    const pages = await client.callTool({ name: 'list_pages', arguments: {} });
    const snapshot = await client.callTool({ name: 'take_snapshot', arguments: {} });
    process.stdout.write(`${JSON.stringify({
      ...result,
      protocolVersion: client.getServerVersion()?.version,
      toolCount: toolNames.length,
      pages: textContent(pages),
      snapshot: normalizeSnapshot(textContent(snapshot)),
    }, null, 2)}\n`);
  }
} finally {
  await client?.close().catch(() => undefined);
  await rm(scratch, { recursive: true, force: true });
}

function parseArgs(args) {
  const parsed = { help: false, tarball: undefined, wsEndpoint: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') parsed.help = true;
    else if (argument === '--tarball') parsed.tarball = requiredValue(args, ++index, argument);
    else if (argument === '--ws-endpoint') {
      parsed.wsEndpoint = requiredValue(args, ++index, argument);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return parsed;
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function printHelp() {
  process.stdout.write(
    'Usage: node scripts/testing/chrome-devtools-mcp-reference.mjs [options]\n\n' +
      'Without --ws-endpoint, verifies the pinned official tarball only.\n' +
      'With --ws-endpoint, runs the official server against an isolated test browser.\n\n' +
      'Options:\n' +
      '  --tarball <path>       Use a pre-downloaded official tarball.\n' +
      '  --ws-endpoint <ws>     Observe pages and snapshot through the reference server.\n' +
      '  -h, --help             Show this help.\n'
  );
}

async function downloadTarball(destination) {
  const response = await fetch(RELEASE.tarballUrl, { redirect: 'error' });
  if (!response.ok) throw new Error(`Tarball download failed: HTTP ${response.status}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
  return destination;
}

function verifyTarball(bytes) {
  const shasum = createHash('sha1').update(bytes).digest('hex');
  if (shasum !== RELEASE.shasum) {
    throw new Error(`Tarball npm shasum mismatch: ${shasum}`);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== RELEASE.sha256) {
    throw new Error(`Tarball SHA-256 mismatch: ${sha256}`);
  }
  const [algorithm, expected] = RELEASE.integrity.split('-', 2);
  const actual = createHash(algorithm).update(bytes).digest('base64');
  if (actual !== expected) throw new Error(`Tarball ${algorithm} integrity mismatch`);
}

function referenceEnvironment() {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
    CI: '1',
    CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
    CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
  };
}

function textContent(result) {
  return result.content
    .filter((entry) => entry.type === 'text')
    .map((entry) => entry.text)
    .join('\n');
}

function normalizeSnapshot(snapshot) {
  const rolesAndNames = snapshot
    .split(/\r?\n/)
    .map((line) => line.replace(/uid=\d+_\d+\s*/g, '').trim())
    .filter((line) => /\b(button|checkbox|combobox|link|option|textbox)\b/i.test(line));
  return { rolesAndNames: rolesAndNames.slice(0, 200) };
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited with code=${code} signal=${signal}`));
    });
  });
}
