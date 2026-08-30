import type { AppSettings } from '../types/index.js';

export function resolveInitialAppLanguage(systemLanguage: string): AppSettings['language'] {
  return /^zh(?:$|[-_])/iu.test(systemLanguage.trim()) ? 'zh-CN' : 'en-US';
}
