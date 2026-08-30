import type { SkillsPort } from '../../skills/ports.js';
import { browserSkillCandidateOverlay } from '../candidate-overlay.js';
import { assertCandidateSourceCurrent } from './build-candidate.js';

export async function publishBrowserSkillCandidate(input: {
  mainAgentId: string;
  force?: boolean;
}, skills?: Pick<SkillsPort, 'install'>) {
  const candidate = browserSkillCandidateOverlay.candidate(input.mainAgentId);
  if (!candidate) throw new Error('No successful Browser Skill build is available to publish');
  await assertCandidateSourceCurrent(candidate);
  const installer = skills ?? (await import('../../core/pilot/pilot-manager.js')).getAppSkillsPort();
  return installer.install({
    source: candidate.sourceDir,
    scope: 'user',
    force: input.force,
    allowExecutable: true,
  });
}
