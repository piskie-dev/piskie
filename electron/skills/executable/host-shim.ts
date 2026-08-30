import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const AUTHOR_API_TARGET = 'core/skill/author-api.js';

export interface ExecutableSkillShim {
  dir: string;
}

/** Refresh the host-owned author API bridge next to one immutable executable build. */
export async function writeExecutableSkillShim(
  buildDir: string,
  piskiepilotRoot = path.resolve(import.meta.dirname, '../../piskiepilot'),
): Promise<ExecutableSkillShim> {
  const shimDir = path.join(buildDir, 'node_modules', 'piskiepilot');
  const emittedTarget = path.join(piskiepilotRoot, AUTHOR_API_TARGET);
  const runtimeTarget = await resolveHostModule(piskiepilotRoot);

  await fs.rm(shimDir, { recursive: true, force: true });
  await fs.mkdir(shimDir, { recursive: true });

  await fs.writeFile(
    path.join(shimDir, 'core-skill.js'),
    `export * from '${pathToFileURL(runtimeTarget).href}';\n`,
  );
  const typeTarget = path.relative(shimDir, emittedTarget).split(path.sep).join('/');
  await fs.writeFile(
    path.join(shimDir, 'core-skill.d.ts'),
    `export * from '${typeTarget}';\n`,
  );
  await fs.writeFile(
    path.join(shimDir, 'package.json'),
    `${JSON.stringify({
      name: 'piskiepilot',
      version: '0.0.0-inprocess',
      private: true,
      type: 'module',
      exports: {
        './core-skill': {
          types: './core-skill.d.ts',
          import: './core-skill.js',
        },
      },
    }, null, 2)}\n`,
  );

  return { dir: shimDir };
}

/** Production uses emitted JavaScript; source-mode tests use the corresponding TypeScript file. */
async function resolveHostModule(piskiepilotRoot: string): Promise<string> {
  const emitted = path.join(piskiepilotRoot, AUTHOR_API_TARGET);
  try {
    await fs.access(emitted);
    return emitted;
  } catch {
    const source = path.join(piskiepilotRoot, 'core/skill/author-api.ts');
    try {
      await fs.access(source);
      return source;
    } catch {
      return emitted;
    }
  }
}
