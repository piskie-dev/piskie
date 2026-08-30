#!/usr/bin/env node
/**
 * 指纹内核 seed 合法性判据复测工具
 *
 * `electron/piskiepilot/browser/fingerprint/seed.ts` 依赖一条实测规律：
 *
 *     deviceMemory 合法(<=8) ⟺ seed ≡ 0 (mod 3)   —— 实测于 fpc-148
 *
 * 该映射由内核内部实现决定，**升级 FPC_RELEASE 时必须复跑本脚本确认判据仍成立**，
 * 再更新 seed.ts 的 LEGAL_SEED_LAW_VERSION。判据失效不会崩，但会让部分环境的
 * deviceMemory 变成 16/32 这类违反 web 规范的可探测值。
 *
 * 用法：
 *   node scripts/fp-seed-sweep.mjs              # 默认采样
 *   node scripts/fp-seed-sweep.mjs --count 120  # 加大连续采样范围
 *
 * 原理：逐 seed 启动内核（headless、临时 profile），页面把 deviceMemory 与 canvas
 * 指纹写进 document.title，脚本经浏览器 HTTP 端点读回——不注入、不 evaluate。
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};
const SAMPLE_COUNT = argOf('count', 60);
const CONCURRENCY = argOf('concurrency', 4);

const KERNEL =
  process.env.FP_CHROMIUM_PATH ||
  join(
    homedir(),
    '.piskie/piskiepilot/fingerprint-bin/darwin-arm64/Chromium.app/Contents/MacOS/Chromium',
  );

if (!existsSync(KERNEL)) {
  console.error(`找不到内核二进制：${KERNEL}\n（可用 FP_CHROMIUM_PATH 指定，或先在应用内完成内核安装）`);
  process.exit(2);
}

const PAGE = `<!doctype html><meta charset=utf-8><title>pending</title><script>
(function(){
  var c=document.createElement('canvas');c.width=200;c.height=50;
  var x=c.getContext('2d');x.textBaseline='top';x.font='14px Arial';
  x.fillStyle='#f60';x.fillRect(10,5,80,20);x.fillStyle='#069';x.fillText('seed probe',4,18);
  var s=c.toDataURL(),h=2166136261;
  for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}
  document.title='dm='+navigator.deviceMemory+'|cv='+((h>>>0).toString(16));
})();
</script>`;

const server = createServer((_q, res) =>
  res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE),
);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function probeSeed(seed) {
  const dir = mkdtempSync(join(tmpdir(), `fp-seed-${seed}-`));
  const child = spawn(
    KERNEL,
    [
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${dir}`,
      `--fingerprint=${seed}`,
      '--fingerprint-platform=macos',
      '--fingerprint-hardware-concurrency=8',
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-background-networking',
    ],
    { stdio: 'ignore' },
  );
  try {
    const portFile = join(dir, 'DevToolsActivePort');
    let port = null;
    for (let i = 0; i < 80; i++) {
      if (existsSync(portFile)) {
        const [line] = readFileSync(portFile, 'utf8').trim().split('\n');
        if (Number(line) > 0) {
          port = Number(line);
          break;
        }
      }
      await wait(100);
    }
    if (!port) return { seed, error: 'no port' };

    const base = `http://127.0.0.1:${port}`;
    const created = await (await fetch(`${base}/json/new?${pageUrl}`, { method: 'PUT' })).json();
    for (let i = 0; i < 60; i++) {
      await wait(150);
      const list = await (await fetch(`${base}/json/list`)).json();
      const row = list.find((t) => t.id === created.id);
      if (row?.title && row.title !== 'pending') {
        const m = /dm=([^|]*)\|cv=(.*)/.exec(row.title);
        return { seed, deviceMemory: m?.[1], canvas: m?.[2] };
      }
    }
    return { seed, error: 'timeout' };
  } finally {
    child.kill('SIGKILL');
    await wait(120);
    rmSync(dir, { recursive: true, force: true });
  }
}

const targets = [
  ...Array.from({ length: SAMPLE_COUNT }, (_, i) => i + 1),
  // 大值抽样：确认判据在整个 uint32 域成立，而非只在小整数区间
  123, 1001, 65535, 123456, 999999999, 1431655764, 3000000000, 4294967292, 4294967295,
];

const results = [];
for (let i = 0; i < targets.length; i += CONCURRENCY) {
  const batch = targets.slice(i, i + CONCURRENCY);
  results.push(...(await Promise.all(batch.map(probeSeed))));
  process.stdout.write(`\r已测 ${results.length}/${targets.length}`);
}
console.log('');

const ok = results.filter((r) => !r.error);
const failed = results.filter((r) => r.error);
const violations = ok.filter((r) => (Number(r.deviceMemory) <= 8) !== (r.seed % 3 === 0));
const distinct = new Set(ok.map((r) => r.canvas)).size;

console.log(`\n采样 ${results.length}，成功 ${ok.length}${failed.length ? `，失败 ${failed.length}` : ''}`);
console.log(`不同 canvas 指纹：${distinct} / ${ok.length}（应相等，否则 seed 未带来熵）`);

if (violations.length === 0) {
  console.log('\n✅ 判据成立：deviceMemory 合法 ⟺ seed ≡ 0 (mod 3)');
  console.log('   可继续沿用 seed.ts 现有实现，仅需更新 LEGAL_SEED_LAW_VERSION。');
  process.exit(0);
}

console.log(`\n❌ 判据被推翻：${violations.length} 个反例`);
for (const v of violations.slice(0, 12)) {
  console.log(`   seed=${v.seed} (mod3=${v.seed % 3}) deviceMemory=${v.deviceMemory}`);
}
console.log('\n请据此重新推导合法性规律，并同步修改 seed.ts 的 alignToLegalSeed。');
process.exit(1);
