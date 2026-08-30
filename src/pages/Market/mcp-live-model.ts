import type { McpSessionRuntimeSummary } from '@shared/types/mcp';
import type { MarketProjectOption } from '@shared/types/market';

import type { CapabilityLocation } from './market-workbench-model';

function hasGlobalCapabilityLocation(locations: readonly CapabilityLocation[]): boolean {
  return locations.some((location) => location.place === 'global' || location.place === 'builtin');
}

/**
 * Global/builtin installs may serve the default workspace and every known Project.
 * A capability installed only into Projects must stay within those explicit locations.
 */
export function mcpLiveQueryWorkspaces(
  locations: readonly CapabilityLocation[],
  projects: readonly MarketProjectOption[],
): Array<string | undefined> {
  if (hasGlobalCapabilityLocation(locations)) {
    return [undefined, ...new Set(projects.map((project) => project.workspace))];
  }

  const projectWorkspaces = locations
    .filter((location) => location.place === 'project' && !location.shared && location.workspace)
    .map((location) => location.workspace as string);
  return projectWorkspaces.length > 0 ? [...new Set(projectWorkspaces)] : [undefined];
}

export function isMcpSessionWorkspaceEligible(
  session: Pick<McpSessionRuntimeSummary, 'workspace'>,
  locations: readonly CapabilityLocation[],
): boolean {
  if (locations.length === 0 || hasGlobalCapabilityLocation(locations)) return true;
  return locations.some((location) => (
    location.place === 'project'
    && !location.shared
    && location.workspace === session.workspace
  ));
}

/** Market needs every active Session in the Project so it can also show "not started here". */
export function mcpLiveSessionQuery(workspace?: string): { workspace?: string } {
  return workspace ? { workspace } : {};
}
