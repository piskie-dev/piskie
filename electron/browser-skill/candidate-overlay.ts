import type { LoadedSkillModule, SkillFunctions } from '../piskiepilot/core/skill/define.js';
import type { CatalogEntry } from '../tools/catalog.js';

const CANDIDATE_AGENT_SPECS = new Set([
  'browser-skill-director',
  'browser-skill-builder',
  'browser-skill-verifier',
]);

/** Only the Browser Skill build roles may observe a AgentRun-local, unpublished candidate. */
export function canAccessBrowserSkillCandidate(agentSpecName: string | undefined): boolean {
  return agentSpecName !== undefined && CANDIDATE_AGENT_SPECS.has(agentSpecName);
}

export type BrowserSkillBuildFailure = Readonly<{
  sourceDir: string;
  skillName?: string;
  at: string;
  message: string;
}>;

export type BrowserSkillCandidate = Readonly<{
  id: string;
  sourceDir: string;
  /** Existing build version directory used by load_skill during verification. */
  resourceRoot: string;
  skillName: string;
  loaded: LoadedSkillModule<'browser', SkillFunctions<'browser'>>;
  entries: readonly CatalogEntry[];
  builtAt: string;
}>;

export type BrowserSkillRunState = Readonly<{
  revision: number;
  candidate?: BrowserSkillCandidate;
  lastBuild: Readonly<{
    ok: boolean;
    at: string;
    sourceDir: string;
    skillName?: string;
    candidateId?: string;
    message?: string;
  }>;
}>;

export type BrowserSkillCandidatePin = Readonly<{
  mainAgentId: string;
  ownerId: string;
  revision: number;
  candidate: BrowserSkillCandidate;
}>;

type MutableRunState = {
  revision: number;
  candidate?: BrowserSkillCandidate;
  lastBuild: BrowserSkillRunState['lastBuild'];
};

/** Process-local candidate projection. Nothing here is written to Registry or inventory. */
export class BrowserSkillCandidateOverlay {
  private readonly runs = new Map<string, MutableRunState>();
  private readonly pins = new Map<string, Map<string, BrowserSkillCandidatePin>>();

  snapshot(mainAgentId: string): BrowserSkillRunState | undefined {
    const state = this.runs.get(mainAgentId);
    if (!state) return undefined;
    return Object.freeze({
      revision: state.revision,
      candidate: state.candidate,
      lastBuild: state.lastBuild,
    });
  }

  register(mainAgentId: string, candidate: BrowserSkillCandidate): BrowserSkillRunState {
    this.assertBuildAllowed(mainAgentId);
    const previous = this.runs.get(mainAgentId);
    const state: MutableRunState = {
      revision: (previous?.revision ?? 0) + 1,
      candidate,
      lastBuild: Object.freeze({
        ok: true,
        at: candidate.builtAt,
        sourceDir: candidate.sourceDir,
        skillName: candidate.skillName,
        candidateId: candidate.id,
      }),
    };
    this.runs.set(mainAgentId, state);
    return this.snapshot(mainAgentId)!;
  }

  recordFailure(mainAgentId: string, failure: BrowserSkillBuildFailure): BrowserSkillRunState {
    if (this.pins.get(mainAgentId)?.size) return this.snapshot(mainAgentId)!;
    const previous = this.runs.get(mainAgentId);
    const state: MutableRunState = {
      revision: (previous?.revision ?? 0) + 1,
      candidate: previous?.candidate,
      lastBuild: Object.freeze({
        ok: false,
        at: failure.at,
        sourceDir: failure.sourceDir,
        skillName: failure.skillName,
        message: failure.message,
      }),
    };
    this.runs.set(mainAgentId, state);
    return this.snapshot(mainAgentId)!;
  }

  candidate(
    mainAgentId: string,
    skillName?: string,
    ownerId?: string,
  ): BrowserSkillCandidate | undefined {
    const candidate = (ownerId ? this.pins.get(mainAgentId)?.get(ownerId)?.candidate : undefined)
      ?? this.runs.get(mainAgentId)?.candidate;
    return candidate && (!skillName || candidate.skillName === skillName) ? candidate : undefined;
  }

  pin(mainAgentId: string, ownerId: string): BrowserSkillCandidatePin {
    const existing = this.pins.get(mainAgentId)?.get(ownerId);
    if (existing) return existing;
    const state = this.runs.get(mainAgentId);
    if (!state?.candidate) {
      throw new Error('Cannot start Browser Skill verification without a successful candidate');
    }
    const pin = Object.freeze({
      mainAgentId,
      ownerId,
      revision: state.revision,
      candidate: state.candidate,
    });
    const runPins = this.pins.get(mainAgentId) ?? new Map<string, BrowserSkillCandidatePin>();
    runPins.set(ownerId, pin);
    this.pins.set(mainAgentId, runPins);
    return pin;
  }

  releasePin(mainAgentId: string, ownerId: string): void {
    const runPins = this.pins.get(mainAgentId);
    if (!runPins) return;
    runPins.delete(ownerId);
    if (runPins.size === 0) this.pins.delete(mainAgentId);
  }

  assertBuildAllowed(mainAgentId: string): void {
    const owners = [...(this.pins.get(mainAgentId)?.keys() ?? [])];
    if (owners.length > 0) {
      throw new Error('Browser Skill cannot be rebuilt while independent validation is running');
    }
  }

  clear(mainAgentId: string): void {
    this.runs.delete(mainAgentId);
    this.pins.delete(mainAgentId);
  }
}

export const browserSkillCandidateOverlay = new BrowserSkillCandidateOverlay();
