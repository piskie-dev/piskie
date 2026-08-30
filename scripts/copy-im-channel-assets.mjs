/**
 * 拷贝 electron/im-gateway/channels/<id>/vendor/ 下的运行时 JS 到 dist-electron 同构位置。
 *
 * 内置 IM 渠道的协议代码收编自上游插件的编译产物（ESM JS，tsc 不 emit），
 * 编译后需镜像到 dist-electron 供渠道 index.ts 相对 import。
 * d.ts 仅供编译期 typecheck，不拷贝。
 *
 * 挂在 build:electron 链尾执行。
 */

import { mkdirSync, readdirSync, statSync, copyFileSync, existsSync } from 'fs';
import { join, dirname, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'electron', 'im-gateway', 'channels');
const DEST = join(root, 'dist-electron', 'electron', 'im-gateway', 'channels');

let copied = 0;

if (existsSync(SRC)) {
  walk(SRC, (file) => {
    // .js 运行时代码 + package.json（模块作用域及渠道协议版本元数据）
    if (!file.endsWith('.js') && !file.endsWith('package.json')) return;
    const rel = relative(SRC, file);
    if (!rel.split(sep).includes('vendor')) return;
    const target = join(DEST, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
    copied++;
  });
}

console.log(`[copy-im-channel-assets] ${copied} files -> ${relative(root, DEST)}`);

function walk(dir, fn) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, fn);
    else fn(p);
  }
}
