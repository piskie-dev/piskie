import { getOverlayCount } from '../console/chrome/overlayPresence';

let owner: symbol | null = null;
let deferWelcome = false;

export function hasGuideObstacle(): boolean {
  if (getOverlayCount() > 0 || document.hidden) return true;
  return Boolean(document.querySelector('dialog[open]'))
    || [...document.querySelectorAll('[popover]:not([role="tooltip"])')].some((element) => element.matches(':popover-open'));
}

export function claimGuide(token: symbol, automatic: boolean): boolean {
  if (owner !== null) return false;
  if (automatic && hasGuideObstacle()) return false;
  owner = token;
  return true;
}

export function releaseGuide(token: symbol): void {
  if (owner !== token) return;
  owner = null;
}

export function deferNextWelcome(): void { deferWelcome = true; }
export function consumeWelcomeDeferral(): boolean {
  const pending = deferWelcome;
  deferWelcome = false;
  return pending;
}
