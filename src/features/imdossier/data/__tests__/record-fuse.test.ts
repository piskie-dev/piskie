import { describe, expect, it } from 'vitest';

import type { MessagingConnectionConfig } from '../../../../../shared/electron-contracts/messaging';
import { faultOfForm, fuseBotRecord, type DossierFormValues } from '../record-fuse';

function form(overrides: Partial<DossierFormValues> = {}): DossierFormValues {
  return {
    name: '值班号',
    channelType: 'feishu',
    appId: 'cli_x1',
    appSecret: '',
    definitionId: 'def-a',
    dmPolicy: 'pairing',
    groupPolicy: 'disabled',
    groupAllowText: '',
    requireMention: true,
    forwardAssistantText: true,
    forwardToolCalls: false,
    forwardToolResults: false,
    ...overrides,
  };
}

const persisted: MessagingConnectionConfig = {
  id: 'bot-1',
  channelType: 'feishu',
  name: '旧名',
  appId: 'cli_old',
  appSecret: 'sk-old',
  definitionId: 'def-old',
  allowFrom: ['u-1'],
  corpId: 'corp-9',
  agentId: 42,
  replyForward: {
    forwardAssistantText: true,
    forwardToolCalls: true,
    forwardToolResults: true,
    toolFilter: { mode: 'include', tools: ['browser.click'] },
  },
};

describe('fuseBotRecord', () => {
  it('打底保留未展示字段(allowFrom/corpId/agentId/toolFilter),表单字段覆盖', () => {
    const fused = fuseBotRecord(persisted, form({ forwardToolCalls: false }), {
      botId: 'bot-1',
      atRest: true,
      scanLogin: false,
    });
    expect(fused.allowFrom).toEqual(['u-1']);
    expect(fused.corpId).toBe('corp-9');
    expect(fused.agentId).toBe(42);
    expect(fused.replyForward?.toolFilter).toEqual({ mode: 'include', tools: ['browser.click'] });
    expect(fused.replyForward?.forwardToolCalls).toBe(false);
    expect(fused.name).toBe('值班号');
  });

  it('Secret 留空保留旧值;填写则覆盖', () => {
    const kept = fuseBotRecord(persisted, form({ appSecret: '' }), {
      botId: 'bot-1',
      atRest: true,
      scanLogin: false,
    });
    expect(kept.appSecret).toBe('sk-old');
    const replaced = fuseBotRecord(persisted, form({ appSecret: ' sk-new ' }), {
      botId: 'bot-1',
      atRest: true,
      scanLogin: false,
    });
    expect(replaced.appSecret).toBe('sk-new');
  });

  it('扫码渠道剥除凭证键', () => {
    const fused = fuseBotRecord(persisted, form({ channelType: 'openclaw-weixin' }), {
      botId: 'bot-1',
      atRest: true,
      scanLogin: true,
    });
    expect('appId' in fused).toBe(false);
    expect('appSecret' in fused).toBe(false);
  });

  it('非静止锁改绑:definitionId 保持持久值;静止可改绑或解绑', () => {
    const locked = fuseBotRecord(persisted, form({ definitionId: 'def-a' }), {
      botId: 'bot-1',
      atRest: false,
      scanLogin: false,
    });
    expect(locked.definitionId).toBe('def-old');
    const rebound = fuseBotRecord(persisted, form({ definitionId: 'def-a' }), {
      botId: 'bot-1',
      atRest: true,
      scanLogin: false,
    });
    expect(rebound.definitionId).toBe('def-a');
    const unbound = fuseBotRecord(persisted, form({ definitionId: undefined }), {
      botId: 'bot-1',
      atRest: true,
      scanLogin: false,
    });
    expect('definitionId' in unbound).toBe(false);
  });

  it('群白名单仅 allowlist 时按行写入;其他策略保留持久值', () => {
    const base: MessagingConnectionConfig = { ...persisted, groupAllowFrom: ['g-old'] };
    const written = fuseBotRecord(
      base,
      form({ groupPolicy: 'allowlist', groupAllowText: ' g-1 \n\n g-2 ' }),
      { botId: 'bot-1', atRest: true, scanLogin: false },
    );
    expect(written.groupAllowFrom).toEqual(['g-1', 'g-2']);
    const untouched = fuseBotRecord(base, form({ groupPolicy: 'disabled' }), {
      botId: 'bot-1',
      atRest: true,
      scanLogin: false,
    });
    expect(untouched.groupAllowFrom).toEqual(['g-old']);
  });

  it('新建(无持久配置):id 取上下文,空可选键不产生', () => {
    const fused = fuseBotRecord(undefined, form({ appSecret: 'sk-1' }), {
      botId: 'bot-new',
      atRest: true,
      scanLogin: false,
    });
    expect(fused.id).toBe('bot-new');
    expect(fused.appSecret).toBe('sk-1');
    expect('corpId' in fused).toBe(false);
  });
});

describe('faultOfForm', () => {
  it('保存必绑任务模板并定位到 definition 字段(存档层草稿语义由 fuseBotRecord 保留)', () => {
    const fault = faultOfForm(form({ definitionId: undefined }), { scanLogin: true, hasStoredSecret: false });
    expect(fault?.field).toBe('definition');
    expect(fault?.messageKey).toBe('imPlugin.validation.templateMissing');
  });

  it('名称必填;非扫码渠道凭证必填;有旧 Secret 时留空放行', () => {
    expect(faultOfForm(form({ name: ' ' }), { scanLogin: false, hasStoredSecret: true })?.field).toBe('name');
    expect(faultOfForm(form({ appId: '' }), { scanLogin: false, hasStoredSecret: true })?.field).toBe('appId');
    expect(faultOfForm(form({ appSecret: '' }), { scanLogin: false, hasStoredSecret: false })?.field).toBe(
      'appSecret',
    );
    expect(faultOfForm(form({ appSecret: '' }), { scanLogin: false, hasStoredSecret: true })).toBeNull();
    expect(faultOfForm(form({ appId: '', appSecret: '' }), { scanLogin: true, hasStoredSecret: false })).toBeNull();
  });
});
