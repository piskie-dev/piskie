export type { PromptContext } from './types.js';
export { assemble, type Identity } from './assemble.js';

// L0 身份（供 AgentSpec 使用）。
export {
  browserWorkerIdentity,
  directorIdentity,
  workerIdentity,
} from './identities/index.js';
