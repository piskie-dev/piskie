import type { AgentSpec } from '../spec.js';
import { browserWorkerSpec } from './browser-worker.js';
import { browserSkillBuilderSpec } from './browser-skill-builder.js';
import { browserSkillDirectorSpec } from './browser-skill-director.js';
import { browserSkillVerifierSpec } from './browser-skill-verifier.js';
import { directorSpec } from './director.js';
import { localWorkerSpec } from './local-worker.js';
import { systemChatSpec } from './system-chat.js';
import { siteScoutSpec } from './site-scout.js';

/** The single registration manifest for built-in Agent runtime specifications. */
export const BUILTIN_AGENT_SPECS = Object.freeze([
  directorSpec,
  systemChatSpec,
  browserWorkerSpec,
  localWorkerSpec,
  browserSkillDirectorSpec,
  siteScoutSpec,
  browserSkillBuilderSpec,
  browserSkillVerifierSpec,
] satisfies readonly AgentSpec[]);
