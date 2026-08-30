import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const [appRootArgument, smokeRootArgument] = process.argv.slice(2);
if (!appRootArgument || !smokeRootArgument) {
  throw new Error('Usage: verify-packaged-app.mjs <app.asar> <temporary-root>');
}

const appRoot = path.resolve(appRootArgument);
const smokeRoot = path.resolve(smokeRootArgument);
const rendererOnlyPackages = [
  '@ant-design/icons',
  '@ant-design/x-markdown',
  '@lobehub/icons',
  '@xyflow/react',
  'framer-motion',
  'i18next',
  'lucide-react',
  'react',
  'react-dom',
  'react-i18next',
  'react-router-dom',
  'zustand',
];
const requiredLegalFiles = [
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'electron/im-gateway/channels/feishu/UPSTREAM.md',
  'electron/im-gateway/channels/feishu/vendor/LICENSE',
  'electron/im-gateway/channels/qqbot/UPSTREAM.md',
  'electron/im-gateway/channels/qqbot/vendor/LICENSE',
  'electron/im-gateway/channels/wecom/UPSTREAM.md',
  'electron/im-gateway/channels/wecom/vendor/LICENSE',
  'electron/im-gateway/channels/weixin/UPSTREAM.md',
  'electron/im-gateway/channels/weixin/vendor/LICENSE',
  'electron/im-gateway/core/openclaw-compat/README.md',
  'electron/im-gateway/core/openclaw-compat/LICENSE',
  'electron/piskiepilot/browser/third_party/chrome-devtools-mcp-1.7.0/LICENSE',
  'electron/piskiepilot/browser/third_party/chrome-devtools-mcp-1.7.0/NOTICE',
  'electron/piskiepilot/browser/third_party/chrome-devtools-mcp-1.7.0/provenance.json',
];

function packagedModule(relativePath) {
  return import(pathToFileURL(path.join(appRoot, relativePath)).href);
}

function assertPathInside(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} resolved outside the package: ${candidate}`);
  }
}

async function assertRegularFile(filePath, label) {
  const stats = await fs.stat(filePath).catch(() => undefined);
  if (!stats?.isFile() || stats.size === 0) {
    throw new Error(`${label} is missing or empty: ${filePath}`);
  }
}

async function assertPathMissing(candidate, label) {
  try {
    await fs.stat(candidate);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${label} must not be included in the packaged application: ${candidate}`);
}

await fs.rm(smokeRoot, { recursive: true, force: true });
try {
  await Promise.all([
    ...requiredLegalFiles.map((relativePath) => (
      assertRegularFile(path.join(appRoot, relativePath), `Legal record ${relativePath}`)
    )),
    ...rendererOnlyPackages.map((packageName) => (
      assertPathMissing(
        path.join(appRoot, 'node_modules', packageName),
        `Renderer-only package ${packageName}`,
      )
    )),
  ]);

  const compilerPath = path.join(
    appRoot,
    'dist-electron/electron/skills/executable/compiler.js',
  );
  const packagedRequire = createRequire(pathToFileURL(compilerPath));
  assertPathInside(appRoot, packagedRequire.resolve('typescript'), 'TypeScript');

  const [compiler, paths, ripgrep] = await Promise.all([
    import(pathToFileURL(compilerPath).href),
    packagedModule('dist-electron/electron/piskiepilot/paths.js'),
    packagedModule('dist-electron/electron/tools/fs/_lib/rg.js'),
  ]);

  paths.setPilotRoot(path.join(smokeRoot, 'piskiepilot'));
  const sourceDirectory = path.join(smokeRoot, 'source');
  await fs.mkdir(sourceDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(sourceDirectory, 'SKILL.md'), [
      '---',
      'name: package-smoke',
      'type: browser',
      'description: Package smoke test',
      '---',
      '',
      '# Package smoke test',
      '',
    ].join('\n'), 'utf8'),
    fs.writeFile(path.join(sourceDirectory, 'skill.ts'), [
      "import { defineSkill, ok, z } from 'piskiepilot/core-skill'",
      "export default defineSkill({ name: 'package-smoke', domain: 'browser', functions: {",
      "  inspect: { description: 'Verify packaged skill compilation', params: z.object({}),",
      "    async run() { return ok('ready') },",
      '  },',
      '} })',
      '',
    ].join('\n'), 'utf8'),
  ]);

  const candidate = await compiler.compileExecutableSkill(
    sourceDirectory,
    'package-smoke',
    { profile: 'browser' },
  );
  const loaded = await import(pathToFileURL(candidate.modulePath).href);
  if (loaded.default?.name !== 'package-smoke') {
    throw new Error('Packaged browser Skill did not load its compiled module');
  }

  const rgPath = ripgrep.getRgPath();
  assertPathInside(`${appRoot}.unpacked`, rgPath, 'ripgrep');
  const { stdout } = await execFileAsync(rgPath, ['--version'], {
    timeout: 15_000,
    windowsHide: true,
  });
  if (!stdout.startsWith('ripgrep ')) {
    throw new Error(`Packaged ripgrep returned unexpected output: ${stdout.trim()}`);
  }

  console.log('Packaged contents, browser Skill, and ripgrep smoke test passed');
} finally {
  await fs.rm(smokeRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 250,
  });
}
