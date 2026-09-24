import i18n from 'i18next';
import { afterEach, describe, expect, it } from 'vitest';

import '@/i18n';
import enUS from '../locales/en-US';
import zhCN from '../locales/zh-CN';
import {
  messageText,
  PresentationError,
  presentationFromError,
  rawText,
  resolvePresentationText,
  type PresentationText,
} from '../presentationText';

function flattenStrings(value: unknown, prefix = ''): Map<string, string> {
  const leaves = new Map<string, string>();
  if (typeof value === 'string') {
    leaves.set(prefix, value);
    return leaves;
  }
  if (!value || typeof value !== 'object') return leaves;

  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    for (const [leafPath, text] of flattenStrings(child, path)) {
      leaves.set(leafPath, text);
    }
  }
  return leaves;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/{{\s*([\w.]+)(?:\s*,[^}]*)?\s*}}/g)]
    .map((match) => match[1]!)
    .sort();
}

function present(text: PresentationText): string {
  return resolvePresentationText(text, (key, values) => i18n.t(key, values ?? {}));
}

afterEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('locale contracts', () => {
  it('keeps the English and Chinese leaf-key sets aligned', () => {
    const english = flattenStrings(enUS);
    const chinese = flattenStrings(zhCN);

    expect([...english.keys()].sort()).toEqual([...chinese.keys()].sort());
  });

  it('uses the same interpolation inputs for every translated leaf', () => {
    const english = flattenStrings(enUS);
    const chinese = flattenStrings(zhCN);

    for (const [key, englishText] of english) {
      expect(placeholders(chinese.get(key) ?? ''), key).toEqual(placeholders(englishText));
    }
  });

  it('resolves singular and plural browser and worker counts in both languages', async () => {
    const cases = [
      ['sharedUi.browserBinding.session.joinedMessageOnly', 'Added 1 browser', 'Added 2 browsers', '已加入 1 个浏览器', '已加入 2 个浏览器'],
      ['transcript.unfinishedWorkers', '1 worker not finished', '2 workers not finished', '1 个子流程未结束', '2 个子流程未结束'],
      ['transcript.failedWorkers', '1 failed', '2 failed', '1 个失败', '2 个失败'],
      ['transcript.stoppedWorkers', '1 stopped', '2 stopped', '1 个已停止', '2 个已停止'],
    ] as const;

    for (const [key, englishOne, englishOther, chineseOne, chineseOther] of cases) {
      await i18n.changeLanguage('en-US');
      expect(i18n.t(key, { count: 1 })).toBe(englishOne);
      expect(i18n.t(key, { count: 2 })).toBe(englishOther);
      await i18n.changeLanguage('zh-CN');
      expect(i18n.t(key, { count: 1 })).toBe(chineseOne);
      expect(i18n.t(key, { count: 2 })).toBe(chineseOther);
    }
  });

  it('re-resolves product copy across locale changes while preserving raw facts', async () => {
    const product = messageText('imPlugin.connectionState.live');
    const raw = rawText('Bot Alpha / external-status');

    await i18n.changeLanguage('zh-CN');
    expect(present(product)).toBe('消息在线');
    expect(present(raw)).toBe('Bot Alpha / external-status');

    await i18n.changeLanguage('en-US');
    expect(present(product)).toBe('Messages Live');
    expect(present(raw)).toBe('Bot Alpha / external-status');

    await i18n.changeLanguage('zh-CN');
    expect(present(product)).toBe('消息在线');
    expect(present(raw)).toBe('Bot Alpha / external-status');
  });

  it('keeps user-entered values raw inside localized validation and error templates', async () => {
    const providerName = '中文供应商';
    const failure = presentationFromError(
      new PresentationError(messageText('settings.inferenceFailure.providerMissing', {
        provider: rawText(providerName),
      })),
      messageText('sessionWorkbenchUi.action.operationFailed'),
    );

    await i18n.changeLanguage('zh-CN');
    expect(present(failure)).toBe(`Provider 不存在：${providerName}`);
    expect(i18n.t('sessionWorkbenchUi.agentActivity.working')).toBe('Working…');
    expect(i18n.t('transcript.title.thinking')).toBe('Think');
    expect(i18n.t('transcript.thinking')).toBe('Thinking');
    expect(i18n.t('sessionWorkbenchUi.runStatus.thinking')).toBe('Thinking');

    await i18n.changeLanguage('en-US');
    expect(present(failure)).toBe(`Provider not found: ${providerName}`);
    expect(i18n.t('sessionWorkbenchUi.agentActivity.working')).toBe('Working…');
    expect(i18n.t('transcript.title.thinking')).toBe('Think');
    expect(i18n.t('transcript.thinking')).toBe('Thinking');
    expect(i18n.t('sessionWorkbenchUi.runStatus.thinking')).toBe('Thinking');

    await i18n.changeLanguage('zh-CN');
    expect(present(failure)).toContain(providerName);
  });

  it('keeps mode names aligned between the welcome and active composers', async () => {
    await i18n.changeLanguage('zh-CN');
    expect([
      i18n.t('sharedUi.agentParams.normal'),
      i18n.t('sharedUi.agentParams.plan'),
      i18n.t('sharedUi.agentParams.browserSkill'),
    ]).toEqual(['默认模式', '计划模式', '网站技能创造']);
    expect([
      i18n.t('sessionWorkbenchUi.composer.modeNormal'),
      i18n.t('sessionWorkbenchUi.composer.modePlan'),
      i18n.t('sessionWorkbenchUi.composer.modeBrowserSkill'),
    ]).toEqual(['默认模式', '计划模式', '网站技能创造']);

    await i18n.changeLanguage('en-US');
    expect([
      i18n.t('sharedUi.agentParams.normal'),
      i18n.t('sharedUi.agentParams.plan'),
      i18n.t('sharedUi.agentParams.browserSkill'),
    ]).toEqual(['Normal', 'Plan', 'Website Skill Creation']);
    expect([
      i18n.t('sessionWorkbenchUi.composer.modeNormal'),
      i18n.t('sessionWorkbenchUi.composer.modePlan'),
      i18n.t('sessionWorkbenchUi.composer.modeBrowserSkill'),
    ]).toEqual(['Normal', 'Plan', 'Website Skill Creation']);
  });
});
