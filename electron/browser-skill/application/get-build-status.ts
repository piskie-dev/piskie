import { browserSkillCandidateOverlay, type BrowserSkillRunState } from '../candidate-overlay.js';

export function getBrowserSkillBuildStatus(mainAgentId: string): BrowserSkillRunState | undefined {
  return browserSkillCandidateOverlay.snapshot(mainAgentId);
}
