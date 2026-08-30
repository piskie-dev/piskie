/**
 * edit 是 file_diff 的唯一生产点，artifact 必须等于执行期
 * `plan.diff`（writeAtomic 成功之后的事实），审批预览不是数据源；一切失败
 * 出口（stale/missing/no match/non-unique/no-change/写异常）都不产生 artifact。
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
  replacements: number;
  matchMode: string;
  diff: Readonly<{ unifiedDiff: string; stat: Readonly<Record<string, number>> }>;
}>;

async function runEdit(
  file: string,
  params: { old_string: string; new_string: string; replace_all?: boolean },
  files: FileGuardPort = makeGuard(),
): Promise<ToolOutput<unknown>> {
  const tool = new EditTool();
  return tool.execute(
    { file_path: file, replace_all: false, ...params },
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
    expect((output.data as EditData).matchMode).toBe('trailing_whitespace');

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
    const params = { file_path: file, old_string: 'line2', new_string: 'LINE2', replace_all: false };

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
      { file_path: file, old_string: 'only', new_string: 'auto', replace_all: false },
      ctxWith(makeGuard()),
    );
    expect(output.ok).toBe(true);
    expect(fileDiffArtifact(output).unifiedDiff).toContain('+auto');
  });
});
