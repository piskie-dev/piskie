/**
 * IMGateway 门面校验。
 *
 * 覆盖：ConfigHost 快照校验、startBot 对悬空 definitionId 的
 * task_definition_unavailable 拒绝，以及 startFn 内同步抛错走
 * failExecution 终态。reservation 与 stop 竞态由 AccountManager 单测覆盖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const definitions = vi.hoisted(() => new Map<
  string,
  { id: string; name: string; purpose: 'general' | 'messaging' }
>());

vi.mock('electron', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-gw-validation-'));
  return {
    app: { getPath: () => dir },
    powerSaveBlocker: { start: () => 1, stop: () => {}, isStarted: () => false },
  };
});



vi.mock('../../core/storage/index.js', () => ({
  taskDefinitionStore: { get: (id: string) => definitions.get(id) ?? null },
}));

vi.mock('../channels/index.js', () => ({
  registerBuiltinChannels: () => {},
  BUILTIN_CHANNEL_INFOS: [],
}));

import { IMGateway } from '../index.js';
import { channelRegistry } from '../core/registry.js';
import type { MessagingConnectionConfig } from '@shared/types/im-gateway.js';

function makeConfig(overrides: Partial<MessagingConnectionConfig> = {}): MessagingConnectionConfig {
  return {
    id: 'bot-1',
    channelType: 'feishu',
    name: 'Bot 1',
    definitionId: 'td-a',
    appId: 'app',
    appSecret: 'secret',
    ...overrides,
  } as MessagingConnectionConfig;
}

function definition(purpose: 'general' | 'messaging' = 'messaging') {
  return { id: 'td-a', name: 'A', purpose };
}

async function publish(gateway: IMGateway, config = makeConfig()): Promise<void> {
  gateway.validateConfigSnapshot([config]);
  await gateway.publishConfigSnapshot([config]);
}

beforeEach(() => {
  definitions.clear();
  vi.restoreAllMocks();
});

describe('definitionId 存在性校验（阻断6）', () => {
  it('ConfigHost 快照校验拒绝悬空 definitionId（模板不存在）', () => {
    const gateway = new IMGateway();
    expect(() => gateway.validateConfigSnapshot([makeConfig({ definitionId: 'td-deleted' })]))
      .toThrow(/task_definition_unavailable/);
    expect(gateway.getBotConfigs()).toHaveLength(0);
  });

  it('ConfigHost accepts an unbound Bot but it cannot start a Connector', async () => {
    const gateway = new IMGateway();
    const config = makeConfig({ definitionId: undefined });

    expect(() => gateway.validateConfigSnapshot([config])).not.toThrow();
    await gateway.publishConfigSnapshot([config]);
    expect(gateway.getBotConfigs()).toEqual([config]);
    await expect(gateway.startBot('bot-1'))
      .rejects.toThrow(/task_definition_unavailable.*未绑定/);
  });

  it('ConfigHost 发布存在的 definitionId', async () => {
    definitions.set('td-a', definition());
    const gateway = new IMGateway();
    await publish(gateway);
    expect(gateway.getBotConfigs().map((b) => b.id)).toEqual(['bot-1']);
  });

  it('ConfigHost 快照校验拒绝 general 用途的 Task Definition', () => {
    definitions.set('td-a', definition('general'));
    const gateway = new IMGateway();

    expect(() => gateway.validateConfigSnapshot([makeConfig()]))
      .toThrow(/task_definition_purpose_mismatch/);
  });

  it('startBot 拒绝启动悬空绑定的 Bot：不进入 reservation、不创建 Connector', async () => {
    definitions.set('td-a', definition());
    const gateway = new IMGateway();
    await publish(gateway);
    definitions.delete('td-a'); // 模板被删除，Bot 保留悬空 definitionId

    const createSpy = vi.spyOn(channelRegistry, 'create');
    await expect(gateway.startBot('bot-1')).rejects.toThrow(/task_definition_unavailable/);
    expect(createSpy).not.toHaveBeenCalled();
    expect(gateway.lifecycleSnapshot().activeBotIds).toEqual([]);
  });

  it('startBot 在模板用途变化后仍拒绝启动', async () => {
    definitions.set('td-a', definition());
    const gateway = new IMGateway();
    await publish(gateway);
    definitions.set('td-a', definition('general'));

    const createSpy = vi.spyOn(channelRegistry, 'create');
    await expect(gateway.startBot('bot-1'))
      .rejects.toThrow(/task_definition_purpose_mismatch/);
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe('Task Definition 删除后 Bot 进入配置错误状态', () => {
  it('invalidateBotsForDeletedTaskDefinition：静止 Bot 发布 error 终态，getBotStates 显示 task_definition_unavailable', async () => {
    definitions.set('td-a', definition());
    const gateway = new IMGateway();
    await publish(gateway);
    definitions.delete('td-a'); // 模板被删除，Bot 保留悬空 definitionId

    const results = await gateway.invalidateBotsForDeletedTaskDefinition('td-a');

    expect(results).toEqual([{ botId: 'bot-1', name: 'Bot 1', stopError: undefined }]);
    const state = gateway.getBotStates().find((s) => s.config.id === 'bot-1');
    expect(state?.status).toBe('error');
    expect(state?.error).toMatch(/task_definition_unavailable/);
    expect(state?.error).toContain('td-a');
  });

  it('读取期派生：运行态 Map 为空（重启/刷新场景）时悬空绑定也显示 error 而非 stopped', async () => {
    definitions.set('td-a', definition());
    const gateway = new IMGateway();
    await publish(gateway);
    definitions.delete('td-a');

    // 不调用 invalidateBotsForDeletedTaskDefinition，直接读取（模拟重启后 AccountManager 无任何运行态）
    const state = gateway.getBotStates().find((s) => s.config.id === 'bot-1');
    expect(state?.status).toBe('error');
    expect(state?.error).toMatch(/task_definition_unavailable/);
  });

  it('绑定完好的静止 Bot 不被派生覆盖：仍显示 stopped', async () => {
    definitions.set('td-a', definition());
    const gateway = new IMGateway();
    await publish(gateway);

    const state = gateway.getBotStates().find((s) => s.config.id === 'bot-1');
    expect(state?.status).toBe('stopped');
    expect(state?.error).toBeUndefined();
  });

  it('推送期派生：迟到 stopped 状态事件在悬空绑定下改发 error，不显示回「已停止」', async () => {
    definitions.set('td-a', definition());
    const gateway = new IMGateway();
    await publish(gateway);
    // 制造运行态历史（全公开路径）：启动失败（测试桩无渠道）→ error 终态入状态 Map
    await expect(gateway.startBot('bot-1')).rejects.toThrow(/No built-in connector/);
    definitions.delete('td-a');

    const pushed: Array<{ botId: string; status: string; error?: string }> = [];
    gateway.statusChanges.subscribe(({ botId, state }) => {
      pushed.push({ botId, status: state.status, error: state.error });
    });

    // 无执行时 stopBot 对非 stopped 历史状态幂等发布 stopped —— 与 stop_failed
    // 后迟到 settle 自动发布 stopped 走同一 onStatusChange 通道，推送层必须派生
    await gateway.stopBot('bot-1');

    expect(pushed.at(-1)).toMatchObject({ botId: 'bot-1', status: 'error' });
    expect(pushed.at(-1)?.error).toMatch(/task_definition_unavailable/);
  });

  it('推送期派生不误伤：绑定完好时 stopped 事件原样推送', async () => {
    definitions.set('td-a', definition());
    const gateway = new IMGateway();
    await publish(gateway);
    await expect(gateway.startBot('bot-1')).rejects.toThrow(/No built-in connector/);

    const pushed: Array<{ status: string }> = [];
    gateway.statusChanges.subscribe(({ state }) => {
      pushed.push({ status: state.status });
    });

    await gateway.stopBot('bot-1');

    expect(pushed.at(-1)).toEqual({ status: 'stopped' });
  });
});

describe('Connector 创建与失败收尾', () => {
  it('startFn 内同步抛错（无内置 connector）走 failExecution 终态，可再次启动', async () => {
    definitions.set('td-a', definition());
    const gateway = new IMGateway();
    // 测试桩未注册任何渠道 → channelRegistry.create 返回 null → startFn 内抛错
    await publish(gateway);

    await expect(gateway.startBot('bot-1')).rejects.toThrow(/No built-in connector/);
    // 终态 error 已清除执行 → 静止，可再次启动（不留 stuck reservation）
    expect(gateway.lifecycleSnapshot().activeBotIds).toEqual([]);
    await expect(gateway.startBot('bot-1')).rejects.toThrow(/No built-in connector/);
  });
});
