/**
 * Module 工厂
 */

import type { AgentModule } from './module.js';
import { SubagentModule } from './subagent.module.js';
import { BrowserModule } from './browser.module.js';
import { ImageModule } from './image.module.js';
import { PlanModule } from './plan.module.js';

const factories: Record<string, () => AgentModule> = {
  'subagent': () => new SubagentModule(),
  'browser': () => new BrowserModule(),
  'image': () => new ImageModule(),
  'plan': () => new PlanModule(),
};

export function createModule(name: string): AgentModule {
  const factory = factories[name];
  if (!factory) {
    throw new Error(`Module "${name}" is not registered. Available: ${Object.keys(factories).join(', ')}`);
  }
  return factory();
}
