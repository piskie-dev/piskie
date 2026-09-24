import { describe, expect, it } from 'vitest';
import {
  JOINED_BROWSER_ENVIRONMENTS_MESSAGE,
  describeJoinedBrowserEnvironments,
} from '../session-browser-environments.js';

const lookup = (id: string) => ({
  'environment-a': { id: 'environment-a', name: 'Sample shop', purpose: 'Sample purchasing' },
  'environment-b': { id: 'environment-b', name: 'Sample forum', purpose: undefined },
}[id]);

describe('describeJoinedBrowserEnvironments', () => {
  it('returns nothing when no environment was selected', () => {
    expect(describeJoinedBrowserEnvironments(undefined, lookup)).toBeUndefined();
    expect(describeJoinedBrowserEnvironments([], lookup)).toBeUndefined();
    expect(describeJoinedBrowserEnvironments([' ', ''], lookup)).toBeUndefined();
  });

  it('describes each joined environment by id, name and purpose in one instruction block', () => {
    const joined = describeJoinedBrowserEnvironments(['environment-a', 'environment-b', 'environment-a'], lookup)!;
    expect(joined.metadata).toEqual({ browserEnvironmentIds: ['environment-a', 'environment-b'] });
    expect(joined.instructions.startsWith(JOINED_BROWSER_ENVIRONMENTS_MESSAGE)).toBe(true);
    expect(joined.instructions).toContain('- id: environment-a; name: Sample shop; purpose: Sample purchasing');
    expect(joined.instructions).toContain('- id: environment-b; name: Sample forum; purpose: （未填写用途）');
  });

  it('keeps unknown ids so the model still sees the exact identifier', () => {
    const joined = describeJoinedBrowserEnvironments(['environment-missing'], lookup)!;
    expect(joined.metadata.browserEnvironmentIds).toEqual(['environment-missing']);
    expect(joined.instructions).toContain('- id: environment-missing; name: environment-missing;');
  });
});
