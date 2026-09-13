/**
 * edit 是 file_diff 的唯一生产点，artifact 必须等于执行期
 * `plan.diff`（writeAtomic 成功之后的事实），审批预览不是数据源；一切失败
 * 出口（stale/missing/no match/non-unique/no-change/写异常）都不产生 artifact。
 *
 * 合同为 `file_path` + `edits[]`：整批在内存里按顺序应用，任一条失败整批不落盘，
 * 成功只写一次、只产一个 artifact（原文到终态的净 diff）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));


import { EditTool } from '../edit.tool.js';
import { unifiedDiff } from '../_lib/diff.js';
import type { FileGuardPort, GuardVerdict, ToolContext, ToolOutput } from '../../types.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piskie-edit-artifact-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'target.txt');
  fs.writeFileSync(file, content);
  return file;
}

function makeGuard(check: () => Promise<GuardVerdict> = async () => 'current'): FileGuardPort {
  return { check: vi.fn(check), record: vi.fn(), forget: vi.fn() };
}

function ctxWith(files: FileGuardPort): ToolContext {
  return { files } as unknown as ToolContext;
}

type EditData = Readonly<{
  path: string;
  edits: number;
  replacements: number;
  matchModes: readonly string[];
  diff: Readonly<{ unifiedDiff: string; stat: Readonly<Record<string, number>> }>;
}>;

type EditInput = { old_string: string; new_string: string; replace_all?: boolean };

/** 补齐 replace_all 默认值——真实调用里由 schema 的 default 完成 */
function editsOf(...edits: EditInput[]) {
  return edits.map((edit) => ({ replace_all: false, ...edit }));
}

async function runEdit(
  file: string,
  edits: EditInput | EditInput[],
  files: FileGuardPort = makeGuard(),
): Promise<ToolOutput<unknown>> {
  const tool = new EditTool();
  return tool.execute(
    { file_path: file, edits: editsOf(...(Array.isArray(edits) ? edits : [edits])) },
    ctxWith(files),
  );
}

function fileDiffArtifact(output: ToolOutput<unknown>) {
  expect(output.artifacts).toBeDefined();
  expect(output.artifacts).toHaveLength(1);
  const artifact = output.artifacts![0];
  expect(artifact.kind).toBe('file_diff');
  if (artifact.kind !== 'file_diff') throw new Error('unreachable');
  return artifact.payload;
}

describe('edit file_diff 生产矩阵', () => {
  it('1. 精确匹配成功：artifact 等于执行期 plan.diff（与 data.diff 同源）', async () => {
    const before = 'line1\nline2\nline3\n';
    const file = tempFile(before);

    const output = await runEdit(file, { old_string: 'line2', new_string: 'LINE2' });
    expect(output.ok).toBe(true);

    const payload = fileDiffArtifact(output);
    const data = output.data as EditData;
    expect(payload.path).toBe(file);
    // 同一份 plan.diff：artifact 与诊断 data 逐字段一致，不做第二次 diff 计算
    expect(payload.unifiedDiff).toBe(data.diff.unifiedDiff);
    expect(payload.stat).toEqual(data.diff.stat);
    // 且与「执行期前后内容」的重算结果一致——落盘事实即 artifact 事实
    const after = fs.readFileSync(file, 'utf-8');
    expect(after).toBe('line1\nLINE2\nline3\n');
    expect(payload.unifiedDiff).toBe(unifiedDiff(file, before, after).unifiedDiff);
    expect(payload.stat).toEqual({ linesAdded: 0, linesDeleted: 0, linesChanged: 1 });
  });

  it('2. whitespace fallback 成功：artifact 对应实际提交内容', async () => {
    const before = 'foo  \nbar\n';
    const file = tempFile(before);

    // old_string 无行尾空白 → 走 trailing_whitespace 匹配
    const output = await runEdit(file, { old_string: 'foo\n', new_string: 'baz\n' });
    expect(output.ok).toBe(true);
    expect((output.data as EditData).matchModes).toEqual(['trailing_whitespace']);
    expect(output.text).toContain('使用忽略行尾空白匹配');

    const payload = fileDiffArtifact(output);
    const after = fs.readFileSync(file, 'utf-8');
    expect(after).toBe('baz\nbar\n');
    expect(payload.unifiedDiff).toBe(unifiedDiff(file, before, after).unifiedDiff);
  });

  it('3. replace_all 多 hunk 完整保存', async () => {
    const gap = Array.from({ length: 10 }, (_, i) => `filler-${i}`).join('\n');
    const before = `target\n${gap}\ntarget\n`;
    const file = tempFile(before);

    const output = await runEdit(file, {
      old_string: 'target',
      new_string: 'replaced',
      replace_all: true,
    });
    expect(output.ok).toBe(true);
    expect((output.data as EditData).replacements).toBe(2);

    const payload = fileDiffArtifact(output);
    expect(payload.unifiedDiff.match(/^@@ /gm)).toHaveLength(2);
    expect(payload.unifiedDiff).toBe(
      unifiedDiff(file, before, fs.readFileSync(file, 'utf-8')).unifiedDiff,
    );
  });

  it('4. stale-at-commit：无 artifact，文件不动', async () => {
    const before = 'line1\nline2\n';
    const file = tempFile(before);

    const output = await runEdit(
      file,
      { old_string: 'line2', new_string: 'LINE2' },
      makeGuard(async () => 'stale'),
    );
    expect(output.ok).toBe(false);
    expect(output.artifacts).toBeUndefined();
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('5. missing/no match/non-unique/no-change/写异常均无 artifact', async () => {
    const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piskie-edit-artifact-'));
    tempDirs.push(missingDir);
    const missing = await runEdit(
      path.join(missingDir, 'absent.txt'),
      { old_string: 'x', new_string: 'y' },
    );
    expect(missing.ok).toBe(false);
    expect(missing.artifacts).toBeUndefined();

    const noMatch = await runEdit(tempFile('abc\n'), { old_string: 'zzz', new_string: 'y' });
    expect(noMatch.ok).toBe(false);
    expect(noMatch.artifacts).toBeUndefined();

    const nonUnique = await runEdit(tempFile('dup\ndup\n'), { old_string: 'dup', new_string: 'y' });
    expect(nonUnique.ok).toBe(false);
    expect(nonUnique.artifacts).toBeUndefined();

    const noChange = await runEdit(tempFile('same\n'), { old_string: 'same', new_string: 'same' });
    expect(noChange.ok).toBe(false);
    expect(noChange.artifacts).toBeUndefined();

    const writeError = await runEdit(
      tempFile('line\n'),
      { old_string: 'line', new_string: 'LINE' },
      makeGuard(async () => {
        throw new Error('guard exploded');
      }),
    );
    expect(writeError.ok).toBe(false);
    expect(writeError.artifacts).toBeUndefined();
    expect(writeError.text).toContain('guard exploded');
  });

  it('6. confirm 预览后文件又变：只持久化执行期 diff，预览不是数据源', async () => {
    const previewState = 'header\nline2\nfooter\n';
    const file = tempFile(previewState);
    const tool = new EditTool();
    const params = { file_path: file, edits: editsOf({ old_string: 'line2', new_string: 'LINE2' }) };

    const preview = await (await tool.prepare(params))();
    expect(preview.type).toBe('diff');
    const previewDiff = (preview as { content: string }).content;

    // 审批窗口内文件被外部改写（目标行仍在，但上下文变了）
    const executionState = 'header\nchanged-context\nline2\nfooter\n';
    fs.writeFileSync(file, executionState);

    const output = await tool.execute(params, ctxWith(makeGuard()));
    expect(output.ok).toBe(true);

    const payload = fileDiffArtifact(output);
    const after = fs.readFileSync(file, 'utf-8');
    expect(payload.unifiedDiff).toBe(unifiedDiff(file, executionState, after).unifiedDiff);
    expect(payload.unifiedDiff).not.toBe(previewDiff);
  });

  it('7. auto 模式（从未调用 prepare）同样产生 artifact', async () => {
    const file = tempFile('only\n');
    const output = await new EditTool().execute(
      { file_path: file, edits: editsOf({ old_string: 'only', new_string: 'auto' }) },
      ctxWith(makeGuard()),
    );
    expect(output.ok).toBe(true);
    expect(fileDiffArtifact(output).unifiedDiff).toContain('+auto');
  });
});

describe('edits[] 批量语义', () => {
  it('多条成功：一次写盘、一个 artifact，diff 等于原文到终态', async () => {
    const before = 'alpha\nbeta\ngamma\n';
    const file = tempFile(before);
    const guard = makeGuard();

    const output = await runEdit(file, [
      { old_string: 'alpha', new_string: 'ALPHA' },
      { old_string: 'gamma', new_string: 'GAMMA' },
    ], guard);
    expect(output.ok).toBe(true);
    expect(output.text).toContain('应用 2 条 edit，共替换 2 处');

    const after = fs.readFileSync(file, 'utf-8');
    expect(after).toBe('ALPHA\nbeta\nGAMMA\n');
    expect(guard.record).toHaveBeenCalledTimes(1);
    const payload = fileDiffArtifact(output);
    expect(payload.unifiedDiff).toBe(unifiedDiff(file, before, after).unifiedDiff);
    const data = output.data as EditData;
    expect(data.edits).toBe(2);
    expect(data.replacements).toBe(2);
    expect(data.matchModes).toEqual(['exact', 'exact']);
  });

  it('后一条在前一条写出的新文本上匹配', async () => {
    const file = tempFile('const a = 1;\n');

    const output = await runEdit(file, [
      { old_string: 'const a = 1;', new_string: 'const total = 1;' },
      { old_string: 'const total = 1;', new_string: 'const total = 2;' },
    ]);
    expect(output.ok).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe('const total = 2;\n');
  });

  it('中间一条未找到：文件不动、无 artifact、错误指出第几条并说明未写入', async () => {
    const before = 'one\ntwo\nthree\n';
    const file = tempFile(before);
    const guard = makeGuard();

    const output = await runEdit(file, [
      { old_string: 'one', new_string: 'ONE' },
      { old_string: 'missing', new_string: 'x' },
      { old_string: 'three', new_string: 'THREE' },
    ], guard);
    expect(output.ok).toBe(false);
    expect(output.text).toContain('Edit 2 of 3');
    expect(output.text).toContain('Nothing was written');
    expect(output.text).not.toContain('已被前面的 edit 改掉');
    expect(output.artifacts).toBeUndefined();
    expect(guard.record).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('前面的 edit 消耗掉了后面的 old_string：给出按应用后内容重写的提示', async () => {
    const before = 'value = old\n';
    const file = tempFile(before);

    const output = await runEdit(file, [
      { old_string: 'value = old', new_string: 'value = new' },
      { old_string: 'old', new_string: 'older' },
    ]);
    expect(output.ok).toBe(false);
    expect(output.text).toContain('Edit 2 of 2');
    expect(output.text).toContain('已被前面的 edit 改掉');
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('中间一条多处命中：错误指出第几条，整批不写', async () => {
    const before = 'dup\nuniq\ndup\n';
    const file = tempFile(before);

    const output = await runEdit(file, [
      { old_string: 'uniq', new_string: 'UNIQ' },
      { old_string: 'dup', new_string: 'x' },
    ]);
    expect(output.ok).toBe(false);
    expect(output.text).toContain('第 2 条 edit 的 old_string');
    expect(output.text).toContain('匹配 2 处');
    expect(output.text).toContain('本次未写入任何修改');
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('replace_all 只作用于本条', async () => {
    const file = tempFile('a\nb\na\nb\n');

    const output = await runEdit(file, [
      { old_string: 'a', new_string: 'A', replace_all: true },
      { old_string: 'b\nA', new_string: 'B\nA' },
    ]);
    expect(output.ok).toBe(true);
    expect((output.data as EditData).replacements).toBe(3);
    expect(fs.readFileSync(file, 'utf-8')).toBe('A\nB\nA\nb\n');
  });

  it('多条里的空白容错按条报告', async () => {
    const file = tempFile('foo  \nbar\n');

    const output = await runEdit(file, [
      { old_string: 'bar', new_string: 'BAR' },
      { old_string: 'foo\n', new_string: 'baz\n' },
    ]);
    expect(output.ok).toBe(true);
    expect((output.data as EditData).matchModes).toEqual(['exact', 'trailing_whitespace']);
    expect(output.text).toContain('第 2 条使用忽略行尾空白匹配');
    expect(fs.readFileSync(file, 'utf-8')).toBe('baz\nBAR\n');
  });

  it('全部应用后文件不变：返回 unchanged 错误，不写盘', async () => {
    const before = 'x\n';
    const file = tempFile(before);
    const guard = makeGuard();

    const output = await runEdit(file, [
      { old_string: 'x', new_string: 'y' },
      { old_string: 'y', new_string: 'x' },
    ], guard);
    expect(output.ok).toBe(false);
    expect(output.text).toContain('leave the file unchanged');
    expect(output.artifacts).toBeUndefined();
    expect(guard.record).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('审批预览展示整批 diff', async () => {
    const before = 'p\nq\n';
    const file = tempFile(before);
    const tool = new EditTool();
    const preview = await (await tool.prepare({
      file_path: file,
      edits: editsOf({ old_string: 'p', new_string: 'P' }, { old_string: 'q', new_string: 'Q' }),
    }))();
    expect(preview.type).toBe('diff');
    expect((preview as { content: string }).content).toBe(unifiedDiff(file, before, 'P\nQ\n').unifiedDiff);
  });
});
