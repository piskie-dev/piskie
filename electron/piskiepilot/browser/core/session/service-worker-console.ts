/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.10.1 src/collectors/ServiceWorkerCollector.ts.
 * The existing browser registry supplies the browser and owns this lifecycle.
 */

import type { Browser, CDPSession, ConsoleMessage, Protocol, Target, WebWorker } from 'puppeteer-core';
import { createIdGenerator, stableIdSymbol, UncaughtError, type WithStableId } from './page-collector.js';

export type ServiceWorkerConsoleObservation = ConsoleMessage | UncaughtError;

class ServiceWorkerSubscriber {
  #session?: CDPSession;
  #worker?: WebWorker;
  #disposed = false;

  constructor(readonly target: Target, readonly collect: (item: ServiceWorkerConsoleObservation) => void) {}

  async subscribe(): Promise<void> {
    this.#session = await this.target.createCDPSession();
    if (this.#disposed) { await this.#session.detach(); return; }
    await this.#session.send('Runtime.enable');
    if (this.#disposed) return;
    this.#session.on('Runtime.exceptionThrown', this.#onException);
    this.#worker = await this.target.worker() ?? undefined;
    if (!this.#disposed) this.#worker?.on('console', this.#onConsole);
  }

  async unsubscribe(): Promise<void> {
    this.#disposed = true;
    this.#worker?.off('console', this.#onConsole);
    this.#session?.off('Runtime.exceptionThrown', this.#onException);
    await this.#session?.detach();
  }

  #onConsole = (message: ConsoleMessage): void => { if (!this.#disposed) this.collect(message); };
  #onException = (event: Protocol.Runtime.ExceptionThrownEvent): void => {
    const serviceWorkerId = extractExtensionId(this.target.url());
    if (!this.#disposed && serviceWorkerId) this.collect(new UncaughtError(event.exceptionDetails, serviceWorkerId));
  };
}

export class ServiceWorkerConsoleCollector {
  readonly #storage = new Map<string, Array<WithStableId<ServiceWorkerConsoleObservation>>>();
  readonly #subscribers = new Map<Target, ServiceWorkerSubscriber>();
  readonly #pending = new Set<Promise<void>>();
  readonly #nextId = createIdGenerator();
  #initialized = false;
  #disposed = false;

  constructor(readonly browser?: Browser, readonly maxLogs = 1000) {}

  async init(targets: readonly Target[] = this.browser?.targets() ?? []): Promise<void> {
    if (!this.browser || this.#initialized || this.#disposed) return;
    this.#initialized = true;
    this.browser.on('targetcreated', this.#onTargetCreated);
    this.browser.on('targetdestroyed', this.#onTargetDestroyed);
    await Promise.all(targets.map(target => this.#attach(target)));
  }

  #onTargetCreated = (target: Target): void => {
    this.#track(this.#attach(target));
  };
  #onTargetDestroyed = (target: Target): void => {
    const subscriber = this.#subscribers.get(target);
    if (!subscriber) return;
    this.#subscribers.delete(target);
    this.#track(subscriber.unsubscribe());
  };

  #track(task: Promise<void>): void {
    this.#pending.add(task);
    void task.catch(() => { /* Closing targets are normal during browser teardown. */ })
      .finally(() => this.#pending.delete(task));
  }

  async #attach(target: Target): Promise<void> {
    if (this.#disposed || this.#subscribers.has(target) || target.type() !== 'service_worker') return;
    const serviceWorkerId = extractExtensionId(target.url());
    if (!serviceWorkerId) return;
    const subscriber = new ServiceWorkerSubscriber(target, item => this.addLog(serviceWorkerId, item));
    this.#subscribers.set(target, subscriber);
    try {
      await subscriber.subscribe();
    } catch (error) {
      this.#subscribers.delete(target);
      await subscriber.unsubscribe().catch(() => undefined);
      if (!isClosedTargetError(error)) throw error;
    }
  }

  addLog(serviceWorkerId: string, log: ServiceWorkerConsoleObservation): void {
    const logs = this.#storage.get(serviceWorkerId) ?? [];
    const item = log as WithStableId<ServiceWorkerConsoleObservation>;
    item[stableIdSymbol] = this.#nextId();
    logs.push(item);
    if (logs.length > this.maxLogs) logs.shift();
    this.#storage.set(serviceWorkerId, logs);
  }

  getData(serviceWorkerId: string): readonly ServiceWorkerConsoleObservation[] {
    return this.#storage.get(serviceWorkerId) ?? [];
  }

  getIdForResource(message: ServiceWorkerConsoleObservation): number {
    return (message as WithStableId<ServiceWorkerConsoleObservation>)[stableIdSymbol] ?? -1;
  }

  getById(serviceWorkerId: string, id: number): ServiceWorkerConsoleObservation {
    const logs = this.#storage.get(serviceWorkerId);
    if (!logs) throw new Error('No logs found for selected extension');
    const item = logs.find(message => message[stableIdSymbol] === id);
    if (!item) throw new Error('Log not found for selected extension');
    return item;
  }

  find(serviceWorkerId: string, filter: (message: WithStableId<ServiceWorkerConsoleObservation>) => boolean): ServiceWorkerConsoleObservation | undefined {
    return this.#storage.get(serviceWorkerId)?.find(filter);
  }

  clearLogs(serviceWorkerId: string): void { this.#storage.delete(serviceWorkerId); }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.browser?.off('targetcreated', this.#onTargetCreated);
    this.browser?.off('targetdestroyed', this.#onTargetDestroyed);
    for (const subscriber of this.#subscribers.values()) this.#track(subscriber.unsubscribe());
    this.#subscribers.clear();
  }

  /** Await detach completion when the registry needs a teardown checkpoint. */
  async settled(): Promise<void> { await Promise.allSettled([...this.#pending]); }
}

function extractExtensionId(origin: string): string | undefined {
  const prefix = 'chrome-extension://';
  if (!origin.startsWith(prefix)) return undefined;
  return origin.substring(prefix.length).split('/')[0] || undefined;
}

function isClosedTargetError(error: unknown): boolean {
  return error instanceof Error && (error.message.includes('Target closed') || error.message.includes('Session closed'));
}
