/**
 * Spec 模块导出 + 内置 Spec 注册
 */

export { deriveWorkerMode, specRegistry } from './spec-registry.js';

// ============================================================
// 注册内置 AgentSpec。
// ============================================================

import { specRegistry } from './spec-registry.js';
import { BUILTIN_AGENT_SPECS } from './builtin/index.js';

for (const spec of BUILTIN_AGENT_SPECS) specRegistry.register(spec);
