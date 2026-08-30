import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

type NodeModuleResolver = (
  request: string,
  parent?: { filename?: string },
  ...rest: unknown[]
) => string;

type ModuleWithResolver = typeof Module & {
  _resolveFilename: NodeModuleResolver;
  [key: symbol]: unknown;
};

interface ResolverState {
  outputDirectory: string;
  compiledModules: ReadonlySet<string>;
}

const STATE_KEY = Symbol.for('piskie.vitest.feishu-cjs-source-resolver');
const nodeModule = Module as ModuleWithResolver;

if (!nodeModule[STATE_KEY]) {
  const sourceDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../im-gateway/core/openclaw-compat',
  );
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'piskie-feishu-compat-'));
  const compiledModules = new Set<string>();

  for (const file of fs.readdirSync(sourceDirectory)) {
    if (!file.endsWith('.ts')) continue;
    const moduleName = file.slice(0, -'.ts'.length);
    const source = fs.readFileSync(path.join(sourceDirectory, file), 'utf8');
    const { code } = transformSync(source, {
      loader: 'ts',
      format: 'cjs',
      target: 'node20',
      sourcefile: file,
    });
    fs.writeFileSync(path.join(outputDirectory, `${moduleName}.js`), code, 'utf8');
    compiledModules.add(moduleName);
  }

  const originalResolve = nodeModule._resolveFilename;
  nodeModule._resolveFilename = function (
    request: string,
    parent?: { filename?: string },
    ...rest: unknown[]
  ): string {
    const match = /[\\/]core[\\/]openclaw-compat[\\/]([\w-]+)\.js$/.exec(request);
    const fromFeishuVendor = parent?.filename?.includes(
      `${path.sep}channels${path.sep}feishu${path.sep}vendor${path.sep}`,
    );
    if (match && fromFeishuVendor && compiledModules.has(match[1]!)) {
      return path.join(outputDirectory, `${match[1]}.js`);
    }
    return originalResolve.call(this, request, parent, ...rest);
  };

  const state: ResolverState = { outputDirectory, compiledModules };
  nodeModule[STATE_KEY] = state;
  process.once('exit', () => fs.rmSync(outputDirectory, { recursive: true, force: true }));
}
