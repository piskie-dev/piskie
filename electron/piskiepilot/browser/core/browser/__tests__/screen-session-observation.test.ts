import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserAutomationSession } from '../../session/browser-automation-session.js';
import { BrowserManager } from '../browser-manager.js';
import { Mutex } from '../shared-mutex.js';

const manager = BrowserManager as unknown as { instances: Map<string, unknown> };
const browserId = 'sample-browser';
const automation = { generation: 'sample-connection',
  withExecutionSignal: <T>(action: () => Promise<T> | T) => action(),
  withOperationFeedback: <T>(action: () => Promise<T> | T) => action(),
} as unknown as BrowserAutomationSession;

beforeEach(() => {
  manager.instances.clear();
  const instance = { automation, browser: { connected: true }, mutex: new Mutex() };
  manager.instances.set(browserId, { getReady: () => instance });
  // Connection creation is outside this test; the common ready-owner/lock path is real.
  vi.spyOn(BrowserManager, 'getOrCreate').mockResolvedValue(browserId);
});
afterEach(() => { manager.instances.clear(); vi.restoreAllMocks(); });

describe('BrowserManager screen session subscription', () => {
  it('registers passively, binds the ready session before dispatch, and stops notifying after release', async () => {
    const order: string[] = [];
    const observe = vi.fn((session: BrowserAutomationSession) => {
      expect(session).toBe(automation);
      order.push('owner');
    });
    const unsubscribe = BrowserManager.subscribeScreenSession(browserId, observe);
    try {
      expect(BrowserManager.getOrCreate).not.toHaveBeenCalled();
      const result = await BrowserManager.runExclusive(browserId, ({ automation: connected }) => {
        order.push('operation'); return connected;
      });
      expect(result).toBe(automation);
      expect(order).toEqual(['owner', 'operation']);
      unsubscribe();
      await BrowserManager.runExclusive(browserId, () => { order.push('next'); });
      expect(observe).toHaveBeenCalledOnce();
    } finally { unsubscribe(); }
  });

  it('does not let a repeated old release remove a replacement subscription for the same browser', async () => {
    const oldRelease = BrowserManager.subscribeScreenSession(browserId, vi.fn());
    oldRelease();
    const next = vi.fn();
    const nextRelease = BrowserManager.subscribeScreenSession(browserId, next);
    try {
      oldRelease();
      await BrowserManager.runExclusive(browserId, () => {});
      expect(next).toHaveBeenCalledWith(automation);
    } finally { nextRelease(); }
  });

  it('keeps original operation return/throw behavior when a passive observer fails', async () => {
    const unsubscribe = BrowserManager.subscribeScreenSession(browserId, () => { throw new Error('Sample observer failure'); });
    try {
      await expect(BrowserManager.runExclusive(browserId, () => 'sample-result')).resolves.toBe('sample-result');
      const error = new Error('Sample operation failure');
      await expect(BrowserManager.runExclusive(browserId, () => { throw error; })).rejects.toBe(error);
    } finally { unsubscribe(); }
  });
});
