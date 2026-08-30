import {
  BROWSER_SKILL_SDK_REFERENCE,
} from '../../../piskiepilot/browser/runtime/generated-skill-browser-reference.js';

/** Generated from the same checked-in SDK declaration source; never hand-edit signatures here. */
export function renderBrowserSkillSdkReference(
  reference = BROWSER_SKILL_SDK_REFERENCE,
): string {
  if (!reference.trim()) {
    throw new Error('Browser Skill SDK API Reference is unavailable');
  }
  return reference;
}
