import browserCore from '../../piskiepilot/browser/skills/browser/skill.js';
import { skillToolName } from '../../piskiepilot/core/skill/define.js';

/** Native filesystem, execution, and Skill-discovery tools. */
export const WORKSPACE_TOOL_NAMES = [
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'ls',
  'shell',
  'tool_search',
] as const;

const BROWSER_READ_NAV_FUNCTIONS = new Set([
  'takeSnapshot',
  'navigateTo',
  'goBack',
  'refresh',
  'listPages',
  'selectPage',
  'takeScreenshot',
]);

const BROWSER_SCOUT_FUNCTIONS = new Set([
  ...BROWSER_READ_NAV_FUNCTIONS,
  'clickByUid',
  'hoverByUid',
]);

const BROWSER_BUILDER_EXCLUDED_FUNCTIONS = new Set([
  'closeBrowser',
  'getAllCookies',
  'setCookies',
  'deleteCookies',
  'clearCookies',
  'getWindowBounds',
  'setWindowBounds',
]);

/** Deny-by-default projection for workers that may inspect/reset a page but not operate it. */
export const BROWSER_READ_NAV_EXCLUDES = Object.freeze(
  Object.keys(browserCore.functions)
    .filter((functionName) => !BROWSER_READ_NAV_FUNCTIONS.has(functionName))
    .map((functionName) => skillToolName(browserCore.name, functionName)),
);

/** Allow bounded menu/entry exploration without form filling or arbitrary page scripts. */
export const BROWSER_SCOUT_EXCLUDES = Object.freeze(
  Object.keys(browserCore.functions)
    .filter((functionName) => !BROWSER_SCOUT_FUNCTIONS.has(functionName))
    .map((functionName) => skillToolName(browserCore.name, functionName)),
);

/** Keep website exploration actions while withholding browser/session administration. */
export const BROWSER_BUILDER_EXCLUDES = Object.freeze(
  Object.keys(browserCore.functions)
    .filter((functionName) => BROWSER_BUILDER_EXCLUDED_FUNCTIONS.has(functionName))
    .map((functionName) => skillToolName(browserCore.name, functionName)),
);
