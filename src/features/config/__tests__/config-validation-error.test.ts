import i18n from 'i18next';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigValidationIssue } from '../../../../shared/types/config';
import { resolvePresentationText } from '../../../i18n/presentationText';
import { ConfigValidationError } from '../config-validation-error';

const issue: ConfigValidationIssue = {
  stage: 'reference',
  code: 'INFERENCE_SELECTION_STILL_REFERENCED',
  path: '/providers/sample/models/chat',
  message: 'ai selection still references sample/chat.',
  details: { gateway: 'ai', providerId: 'sample', modelId: 'chat', targetKind: 'model' },
};

function present(error: ConfigValidationError): string {
  return resolvePresentationText(error.presentation, (key, values) => i18n.t(key, values ?? {}));
}

afterEach(async () => { await i18n.changeLanguage('zh-CN'); });

describe('configuration validation presentation', () => {
  it.each([
    ['model', '此模型是当前默认模型，请先选择其他模型，再关闭或删除。',
      'This is the current default model. Select another model before disabling or deleting it.'],
    ['provider', '此供应商包含当前默认模型，请先选择其他供应商的模型，再关闭或删除该供应商。',
      'This provider contains the current default model. Select a model from another provider before disabling or deleting this provider.'],
  ])('translates the %s guard and switches languages without losing diagnostics', async (targetKind, chinese, english) => {
    const original = { ...issue, details: { ...issue.details, targetKind } };
    const error = new ConfigValidationError('inference', [original]);

    await i18n.changeLanguage('zh-CN');
    expect(present(error)).toBe(chinese);
    await i18n.changeLanguage('en-US');
    expect(present(error)).toBe(english);
    expect(error.code).toBe(issue.code);
    expect(error.domain).toBe('inference');
    expect(error.issues).toEqual([original]);
    expect(error.message).toBe(`${issue.path}: ${issue.message}`);
  });

  it('preserves unknown diagnostics alongside translated issues', () => {
    const unknown = { ...issue, code: 'CUSTOM_VALIDATION', path: '/custom', message: 'Custom failure' };
    const error = new ConfigValidationError('inference', [issue, unknown]);

    expect(present(error)).toBe('此模型是当前默认模型，请先选择其他模型，再关闭或删除。\n/custom: Custom failure');
    expect(error.issues).toEqual([issue, unknown]);
    expect(error.message).toContain('/custom: Custom failure');
  });

  it('provides a localized fallback when validation contains no issues', async () => {
    const error = new ConfigValidationError('inference', []);
    expect(error.code).toBe('CONFIG_VALIDATION_FAILED');
    expect(present(error)).toBe('配置校验未通过，请检查设置后重试。');
    await i18n.changeLanguage('en-US');
    expect(present(error)).toBe('Configuration validation failed. Check your settings and try again.');
  });
});
