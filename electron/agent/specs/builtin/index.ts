import type { AgentSpec } from '../spec.js';
import type { WorkerDefinition } from '../worker-definition.js';
import { exploreDefinition } from './explore.js';
import { browserWorkerDefinition } from './browser-worker.js';
import { browserSkillBuilderDefinition } from './browser-skill-builder.js';
import { browserSkillDirectorSpec } from './browser-skill-director.js';
import { browserSkillVerifierDefinition } from './browser-skill-verifier.js';
import { directorSpec } from './director.js';
import { localWorkerDefinition } from './local-worker.js';
import { systemChatSpec } from './system-chat.js';
import { siteScoutDefinition } from './site-scout.js';

export const BUILTIN_DIRECTOR_SPECS = Object.freeze([
  directorSpec, systemChatSpec, browserSkillDirectorSpec,
] satisfies readonly AgentSpec[]);

export const BUILTIN_WORKER_DEFINITIONS = Object.freeze([
  browserWorkerDefinition, localWorkerDefinition, exploreDefinition,
  siteScoutDefinition, browserSkillBuilderDefinition, browserSkillVerifierDefinition,
] satisfies readonly WorkerDefinition[]);
