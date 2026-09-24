import type { UserMessageMetadata } from '../../../shared/types/agent-control.js';
import type { BrowserEnvironment } from '../../../shared/types/index.js';
import { uniqueBrowserEnvironmentIds } from '../../../shared/schemas/browser-environment-selection.js';
import { resolveBrowserEnvironmentPurpose } from '../../../shared/utils/browser-environment.js';

export const JOINED_BROWSER_ENVIRONMENTS_MESSAGE =
  '以下浏览器环境已由用户加入当前会话，可用于后续创建 browser worker：';

export type BrowserEnvironmentLookup = (
  id: string,
) => Pick<BrowserEnvironment, 'id' | 'name' | 'purpose'> | undefined;

/**
 * Describe the environments one user message joins to the session.
 * The model reads id/name/purpose from instructions; metadata keeps IDs only.
 */
export function describeJoinedBrowserEnvironments(
  ids: readonly string[] | undefined,
  lookup: BrowserEnvironmentLookup,
): { metadata: UserMessageMetadata; instructions: string } | undefined {
  const browserEnvironmentIds = uniqueBrowserEnvironmentIds(ids);
  if (browserEnvironmentIds.length === 0) return undefined;
  const lines = browserEnvironmentIds.map((id) => {
    const environment = lookup(id);
    return `- id: ${id}; name: ${environment?.name ?? id}; purpose: ${resolveBrowserEnvironmentPurpose(environment ?? {})}`;
  });
  return {
    metadata: { browserEnvironmentIds },
    instructions: `${JOINED_BROWSER_ENVIRONMENTS_MESSAGE}\n${lines.join('\n')}`,
  };
}
