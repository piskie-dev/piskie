import { describe, expect, it } from 'vitest';

import {
  isMcpSessionWorkspaceEligible,
  mcpLiveQueryWorkspaces,
  mcpLiveSessionQuery,
} from '../mcp-live-model';
import type { CapabilityLocation } from '../market-workbench-model';

describe('MCP Market live query scope', () => {
  it('queries default plus every Project and allows all sessions for a global install', () => {
    const globalLocation = {
      key: 'global:',
      place: 'global',
      label: '全局',
      shared: false,
    } as CapabilityLocation;
    const inheritedProject = {
      key: 'project:/work/a',
      place: 'project',
      label: 'A',
      workspace: '/work/a',
      shared: true,
    } as CapabilityLocation;
    const projects = [
      { workspace: '/work/a' },
      { workspace: '/work/b' },
    ] as unknown as import('@shared/types/market').MarketProjectOption[];

    expect(mcpLiveQueryWorkspaces([globalLocation, inheritedProject], projects)).toEqual([
      undefined,
      '/work/a',
      '/work/b',
    ]);
    expect(isMcpSessionWorkspaceEligible({ workspace: undefined }, [globalLocation])).toBe(true);
    expect(isMcpSessionWorkspaceEligible({ workspace: '/work/b' }, [globalLocation])).toBe(true);
  });

  it('limits query and visible sessions to explicit locations for a project-only install', () => {
    const projectLocation = {
      key: 'project:/work/a',
      place: 'project',
      label: 'A',
      workspace: '/work/a',
      shared: false,
    } as CapabilityLocation;
    const projects = [
      { workspace: '/work/a' },
      { workspace: '/work/b' },
    ] as unknown as import('@shared/types/market').MarketProjectOption[];

    expect(mcpLiveQueryWorkspaces([projectLocation], projects)).toEqual(['/work/a']);
    expect(isMcpSessionWorkspaceEligible({ workspace: '/work/a' }, [projectLocation])).toBe(true);
    expect(isMcpSessionWorkspaceEligible({ workspace: '/work/b' }, [projectLocation])).toBe(false);
    expect(isMcpSessionWorkspaceEligible({ workspace: undefined }, [projectLocation])).toBe(false);
  });

  it('queries every Session in a Project instead of pre-filtering by server name', () => {
    expect(mcpLiveSessionQuery()).toEqual({});
    expect(mcpLiveSessionQuery('/work/a')).toEqual({ workspace: '/work/a' });
    expect(mcpLiveSessionQuery('/work/a')).not.toHaveProperty('serverName');
  });
});
