import { Blocks, Bot, Globe, Radar, Search, ShieldCheck, TerminalSquare } from 'lucide-react';

const workerTypes = {
  explore: {
    icon: Search,
    labelKey: 'sessionWorkbenchUi.workerTypes.explore',
    shortLabelKey: 'sessionWorkbenchUi.workerTypeLabels.explore',
  },
  'local-worker': {
    icon: TerminalSquare,
    labelKey: 'sessionWorkbenchUi.workerTypes.local',
    shortLabelKey: 'sessionWorkbenchUi.workerTypeLabels.local',
  },
  'browser-worker': {
    icon: Globe,
    labelKey: 'sessionWorkbenchUi.workerTypes.browser',
    shortLabelKey: 'sessionWorkbenchUi.workerTypeLabels.browser',
  },
  'site-scout': {
    icon: Radar,
    labelKey: 'sessionWorkbenchUi.workerTypes.scout',
    shortLabelKey: 'sessionWorkbenchUi.workerTypeLabels.scout',
  },
  'browser-skill-builder': {
    icon: Blocks,
    labelKey: 'sessionWorkbenchUi.workerTypes.builder',
    shortLabelKey: 'sessionWorkbenchUi.workerTypeLabels.builder',
  },
  'browser-skill-verifier': {
    icon: ShieldCheck,
    labelKey: 'sessionWorkbenchUi.workerTypes.verifier',
    shortLabelKey: 'sessionWorkbenchUi.workerTypeLabels.verifier',
  },
} as const;

export function workerPresentation(type: string) {
  return Object.hasOwn(workerTypes, type)
    ? workerTypes[type as keyof typeof workerTypes]
    : {
      icon: Bot,
      labelKey: 'sessionWorkbenchUi.workerTypes.custom',
      shortLabelKey: 'sessionWorkbenchUi.workerTypeLabels.custom',
    };
}
