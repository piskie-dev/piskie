import type { BrowserWindow } from 'electron';
import type { AgentTarget } from '../../shared/types/agent-control.js';
import { EMPTY_EMBEDDED_BROWSER_STATE, type EmbeddedBrowserState } from '../../shared/types/embedded-browser.js';
import { createChangeChannel } from '../core/change-channel.js';
import type { EmbeddedBrowserPresentation } from './desktop-presentation-port.js';
import { EmbeddedBrowserSession } from './embedded-browser-session.js';

interface BrowserEntry {
  readonly target: AgentTarget;
  readonly page: EmbeddedBrowserSession;
  readonly unsubscribe: () => void;
}

function keyOf(target: AgentTarget): string {
  return JSON.stringify([target.agentId, target.workerId ?? null]);
}

/** Owns preview pages for one window; only the selected page is attached. */
export class EmbeddedBrowserRegistry implements EmbeddedBrowserPresentation {
  private readonly pages = new Map<string, BrowserEntry>();
  private readonly channel = createChangeChannel<{ target: AgentTarget; state: EmbeddedBrowserState }>();
  private visibleKey?: string;
  private disposed = false;
  readonly changes = this.channel.source;

  constructor(private readonly window: BrowserWindow) {
    window.webContents.on('did-start-navigation', this.hide);
    window.webContents.on('render-process-gone', this.hide);
  }

  open(target: AgentTarget): EmbeddedBrowserSession {
    if (this.disposed) throw new Error('Embedded browser registry is closed');
    const key = keyOf(target);
    let entry = this.pages.get(key);
    if (!entry) {
      const page = new EmbeddedBrowserSession(this.window);
      const owner = { ...target };
      const unsubscribe = page.changes.subscribe((state) => {
        this.channel.sink.publish({ target: owner, state });
      });
      entry = { target: owner, page, unsubscribe };
      this.pages.set(key, entry);
    }
    entry.page.open();
    this.channel.sink.publish({ target: entry.target, state: entry.page.state() });
    return entry.page;
  }

  get(target: AgentTarget): EmbeddedBrowserSession | undefined {
    return this.pages.get(keyOf(target))?.page;
  }

  state(target: AgentTarget): EmbeddedBrowserState {
    return this.get(target)?.state() ?? EMPTY_EMBEDDED_BROWSER_STATE;
  }

  close(target: AgentTarget): void {
    const key = keyOf(target);
    const entry = this.pages.get(key);
    if (!entry) return;
    this.pages.delete(key);
    if (this.visibleKey === key) this.visibleKey = undefined;
    entry.unsubscribe();
    entry.page.dispose();
    this.channel.sink.publish({ target: entry.target, state: EMPTY_EMBEDDED_BROWSER_STATE });
  }

  setBounds(target: AgentTarget, bounds: { x: number; y: number; width: number; height: number }): void {
    this.get(target)?.setBounds(bounds);
  }

  setVisible(target: AgentTarget, visible: boolean): void {
    const key = keyOf(target);
    if (!visible) {
      if (this.visibleKey === key) this.hide();
      return;
    }
    const entry = this.pages.get(key);
    if (!entry) return;
    if (this.visibleKey !== key) this.hide();
    entry.page.setVisible(true);
    this.visibleKey = key;
  }

  releaseAgent(agentId: string): void {
    for (const { target } of this.pages.values()) {
      if (target.agentId === agentId) this.close(target);
    }
  }

  retainWorkers(agentId: string, workerIds: ReadonlySet<string>): void {
    for (const { target } of this.pages.values()) {
      if (target.agentId === agentId && target.workerId && !workerIds.has(target.workerId)) {
        this.close(target);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.window.isDestroyed()) {
      this.window.webContents.removeListener('did-start-navigation', this.hide);
      this.window.webContents.removeListener('render-process-gone', this.hide);
    }
    for (const { target } of this.pages.values()) this.close(target);
  }

  snapshot(): { disposed: boolean; pages: number; visible: boolean } {
    return { disposed: this.disposed, pages: this.pages.size, visible: this.visibleKey !== undefined };
  }

  private readonly hide = (): void => {
    if (this.visibleKey !== undefined) this.pages.get(this.visibleKey)?.page.setVisible(false);
    this.visibleKey = undefined;
  };
}
