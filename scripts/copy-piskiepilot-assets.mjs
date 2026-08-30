/**
 * 拷贝 electron/piskiepilot 下 tsc 不会 emit 的运行时资产到 dist-electron 同构位置:
 *
 * 1. 非 .ts 资产 — skills 的 SKILL.md/*.json、第三方 License/NOTICE 等
 *    (skill-loader 通过 import.meta.url 相对定位,dist 镜像结构即可正常工作)
 * 2. 产品内置标准 Skills — 只在 load_skill 时向模型提供完整 SKILL.md
 *
 * 挂在 build:electron 链尾执行。
 */

import { cpSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'electron', 'piskiepilot');
const DEST = join(root, 'dist-electron', 'electron', 'piskiepilot');
const STANDARD_SKILLS_SRC = join(root, 'skills');
const STANDARD_SKILLS_DEST = join(root, 'dist-electron', 'skills');

let copied = 0;

// 1. Non-TypeScript runtime assets, including third-party attribution.
walk(SRC, (file) => {
  if (file.endsWith('.ts')) return;
  const target = join(DEST, relative(SRC, file));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(file, target);
  copied++;
});

// 2. 产品内置标准 Skills 保持与源码运行一致的相对目录。
cpSync(STANDARD_SKILLS_SRC, STANDARD_SKILLS_DEST, { recursive: true });
copied += countFiles(STANDARD_SKILLS_SRC);

console.log(`[copy-piskiepilot-assets] ${copied} files -> ${relative(root, DEST)}`);

function walk(dir, fn) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, fn);
    else fn(p);
  }
}

function countFiles(dir) {
  let n = 0;
  walk(dir, () => n++);
  return n;
}
