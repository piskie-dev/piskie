/** 用途说明的长度上限（给 AI 看的一段话，超出即截断） */
export const BROWSER_ENVIRONMENT_PURPOSE_MAX_LENGTH = 200;

/** trim + 截断到 200 字；空白视为未填写 */
export function clampBrowserEnvironmentPurpose(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, BROWSER_ENVIRONMENT_PURPOSE_MAX_LENGTH);
}

/** AI 只看 name + 用途；未填写时回退占位文案，供主进程与 UI 共用。 */
export function resolveBrowserEnvironmentPurpose(environment: { purpose?: string }): string {
  return clampBrowserEnvironmentPurpose(environment.purpose) ?? '（未填写用途）';
}
