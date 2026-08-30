import { describe, expect, it, vi } from 'vitest';
import path from 'path';
import fs from 'fs/promises';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const root = mkdtempSync(nodePath.join(os.tmpdir(), 'plan-service-test-'));
  return {
    app: {
      getPath: () => root,
      getAppPath: () => root,
    },
  };
});

import { app } from 'electron';
import { planRepository } from '../plan-repository.js';

const DOC = [
  '## 背景与目标',
  '调研三个网站的价格。',
  '',
  '## 关键决策及理由',
  '按网站拆分子流程。',
].join('\n');

describe('planRepository 计划文档存储', () => {
  it('同 taskSummary 两次 create 生成互异 planId（-2 去重），两文件并存', async () => {
    const first = await planRepository.createPlan('main-dedupe', '价格调研', DOC);
    const second = await planRepository.createPlan('main-dedupe', '价格调研', DOC);

    expect(first.planId).toBe('价格调研');
    expect(second.planId).toBe('价格调研-2');
    await expect(fs.access(first.documentPath)).resolves.toBeUndefined();
    await expect(fs.access(second.documentPath)).resolves.toBeUndefined();
  });

  it('正文落盘为纯 markdown 散文（无 JSON 元数据块）', async () => {
    const { documentPath } = await planRepository.createPlan('main-prose', '纯正文', DOC);

    const content = await fs.readFile(documentPath, 'utf-8');
    expect(content).toBe(DOC);
    expect(content).not.toContain('TASK_DATA');
    expect(content).not.toContain('PLAN_DATA');
  });

  it('current.json 指针 round-trip：create 后指向最新计划，readCurrentPlan 返回元信息', async () => {
    await planRepository.createPlan('main-pointer', '第一版', DOC);
    const { planId, documentPath } = await planRepository.createPlan('main-pointer', '第二版', DOC);

    const pointer = JSON.parse(await fs.readFile(path.join(
      app.getPath('userData'),
      'agent-runs',
      'main-pointer',
      'plans',
      'current.json',
    ), 'utf-8')) as { currentPlanId: string; taskSummary: string };
    expect(pointer.currentPlanId).toBe(planId);
    expect(pointer.taskSummary).toBe('第二版');

    const meta = await planRepository.readCurrentPlan('main-pointer');
    expect(meta).toMatchObject({ planId, taskSummary: '第二版', documentPath });
  });

  it('readCurrentPlanDocument 返回指针元信息与正文内容', async () => {
    await planRepository.createPlan('main-doc', '带正文', DOC);

    const doc = await planRepository.readCurrentPlanDocument('main-doc');
    expect(doc?.meta.taskSummary).toBe('带正文');
    expect(doc?.content).toBe(DOC);
  });

  it('无指针文件时公开读取返回 null', async () => {
    expect(await planRepository.readCurrentPlan('main-none')).toBeNull();
    expect(await planRepository.readCurrentPlanDocument('main-none')).toBeNull();
  });

  it('指针存在但正文文件缺失时 readCurrentPlan 返回 null', async () => {
    const { documentPath } = await planRepository.createPlan('main-missing', '会被删掉', DOC);
    await fs.unlink(documentPath);

    expect(await planRepository.readCurrentPlan('main-missing')).toBeNull();
  });

  it('taskSummary 全为非法字符时 slug 兜底 untitled', async () => {
    const { planId, documentPath } = await planRepository.createPlan('main-untitled', '<>:"/\\|?*', DOC);

    expect(planId).toBe('untitled');
    expect(path.basename(documentPath)).toBe('untitled.md');
    // 存储根来自 mock 的 userData
    expect(documentPath.startsWith(app.getPath('userData'))).toBe(true);
  });
});
