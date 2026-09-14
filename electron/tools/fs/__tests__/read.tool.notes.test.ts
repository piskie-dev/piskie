/**
 * read 的结果提示只在需要时出现：整读完毕不加话；模型自己传的 limit 截住了读取
 * 只报"已显示 X-Y 行（共 N 行）"，不指挥下一步；只有工具上限（默认 2000 行或
 * 字节预算）截住读取时才给出带 offset 的续读方式。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

import { ReadTool } from '../read.tool.js';
import type { FileGuardPort, ToolContext } from '../../types.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piskie-read-notes-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'target.txt');
  fs.writeFileSync(file, content);
  return file;
}

function numberedLines(count: number, width = 0): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`.padEnd(width, 'x')).join('\n');
}

function ctx(): ToolContext {
  const files: FileGuardPort = { check: vi.fn(async () => 'current'), record: vi.fn(), forget: vi.fn() };
  return { files } as unknown as ToolContext;
}

async function runRead(file: string, params: { offset?: number; limit?: number } = {}) {
  return new ReadTool().execute({
    file_path: file,
    offset: params.offset ?? 1,
    limit: params.limit ?? 2_000,
  }, ctx());
}

describe('read 结果提示', () => {
  it('整读完毕时不附加任何提示', async () => {
    const output = await runRead(tempFile(numberedLines(5)));

    expect(output.ok).toBe(true);
    expect(output.text.trimStart()).toMatch(/^1\tline 1\n/u);
    expect(output.text).toMatch(/5\tline 5$/u);
    expect(output.text).not.toContain('已显示');
    expect(output.data).toMatchObject({ totalLines: 5, linesShown: 5, nextOffset: undefined });
  });

  it('模型自己的 limit 截住读取时只报已显示范围与总行数，不给续读指令', async () => {
    const output = await runRead(tempFile(numberedLines(197)), { offset: 20, limit: 80 });

    expect(output.ok).toBe(true);
    expect(output.text).toContain('已显示 20-99 行（共 197 行）。');
    expect(output.text).not.toContain('继续读');
    expect(output.data).toMatchObject({ totalLines: 197, linesShown: 80, nextOffset: 100 });
  });

  it('模型的 limit 恰好读到文件末尾时不附加提示', async () => {
    const output = await runRead(tempFile(numberedLines(100)), { offset: 41, limit: 60 });

    expect(output.text).not.toContain('已显示');
    expect(output.data).toMatchObject({ totalLines: 100, linesShown: 60, nextOffset: undefined });
  });

  it('默认 2000 行上限截住读取时给出带 offset 的续读方式', async () => {
    const file = tempFile(numberedLines(2_500));
    const output = await runRead(file);

    expect(output.text).toContain('已显示 1-2000 行（共 2500 行）。');
    expect(output.text).toContain(`继续读：read({"file_path":${JSON.stringify(file)},"offset":2001})`);
    expect(output.data).toMatchObject({ totalLines: 2_500, linesShown: 2_000, nextOffset: 2_001 });
  });

  it('模型显式要求的行数不低于默认上限时同样视为工具截断', async () => {
    const file = tempFile(numberedLines(2_500));
    const output = await runRead(file, { offset: 1, limit: 2_000 });

    expect(output.text).toContain('继续读');
    expect(output.data).toMatchObject({ nextOffset: 2_001 });
  });

  it('字节预算先于 limit 截住读取时给出续读方式', async () => {
    // 每行约 300 字节，2000 行约 600KB，超过 384KB 预算；文件不到 2000 行，只有预算会截断。
    const file = tempFile(numberedLines(1_800, 300));
    const output = await runRead(file);

    expect(output.ok).toBe(true);
    expect(output.text).toContain('（共 1800 行）。继续读：');
    expect(output.data?.nextOffset).toBeDefined();
    expect(output.data?.linesShown).toBeLessThan(1_800);
  });

  it('工具描述与参数说明沿用整读默认', () => {
    const tool = new ReadTool();
    const shape = tool.def.schema.shape;

    expect(tool.def.description).toContain('Without offset and limit a call returns the whole file, up to 2000 lines');
    expect(tool.def.description).toContain('When you already know which part of the file you need, only read that part.');
    expect(tool.def.description).not.toContain('384');
    expect(shape.offset.description).toContain('Only provide if the file is too large to read at once');
    expect(shape.limit.description).toContain('Only provide if the file is too large to read at once');
  });
});
