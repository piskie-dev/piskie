import { describe, expect, it, vi } from 'vitest';
import { PILOT_OPERATIONS, PILOT_TOPICS } from '../../../../shared/electron-contracts/pilot.js';
import { EMPTY_EMBEDDED_BROWSER_STATE, type EmbeddedBrowserState } from '../../../../shared/types/embedded-browser.js';
import type { AgentTarget } from '../../../../shared/types/agent-control.js';
import { createChangeChannel } from '../../../core/change-channel.js';
import { createPilotController } from '../pilot-controller.js';

describe('embedded browser controller routing', () => {
  const target = { agentId: 'session-alpha', workerId: 'worker-one' };
  const context = { windowId: 7, generation: 'generation-one', connectionId: 'connection-one', signal: new AbortController().signal };

  function fixture() {
    const channel = createChangeChannel<{ target: AgentTarget; state: EmbeddedBrowserState }>();
    const browser = { changes: channel.source, state: vi.fn(() => EMPTY_EMBEDDED_BROWSER_STATE), close: vi.fn() };
    const application = { embeddedBrowser: vi.fn(() => browser), showScreen: vi.fn() };
    return { channel, browser, application, controller: createPilotController(application as never) };
  }

  it('subscribes to the caller window and selected conversation target', async () => {
    const { controller, browser, application, channel } = fixture();
    const topic = controller.topics.find((entry) => entry.id === PILOT_TOPICS.embeddedBrowser)!;
    const listener = vi.fn();
    const subscription = await topic.open(context, topic.input.parse(target), listener);
    expect(application.embeddedBrowser).toHaveBeenCalledWith(7);
    expect(browser.state).toHaveBeenCalledWith(target);
    expect(subscription.snapshot).toBe(EMPTY_EMBEDDED_BROWSER_STATE);
    channel.sink.publish({ target: { agentId: 'session-alpha' }, state: EMPTY_EMBEDDED_BROWSER_STATE });
    channel.sink.publish({ target: { ...target, agentId: 'session-beta' }, state: EMPTY_EMBEDDED_BROWSER_STATE });
    expect(listener).not.toHaveBeenCalled();
    channel.sink.publish({ target, state: { ...EMPTY_EMBEDDED_BROWSER_STATE, open: true } });
    expect(listener).toHaveBeenCalledOnce();
    await subscription.dispose();
    channel.sink.publish({ target, state: EMPTY_EMBEDDED_BROWSER_STATE });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('requires an explicit owner for closing and routes only that preview', async () => {
    const { controller, browser, application } = fixture();
    const operation = controller.operations.find((entry) => entry.id === PILOT_OPERATIONS.closeEmbeddedBrowser)!;
    expect(operation.input.safeParse([]).success).toBe(false);
    await operation.execute(context, operation.input.parse([target]));
    expect(browser.close).toHaveBeenCalledWith(target);
    expect(application.showScreen).not.toHaveBeenCalled();
  });
});
