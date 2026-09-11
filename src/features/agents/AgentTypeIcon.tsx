import {
  Bot,
  FileSearch,
  Globe,
  ListChecks,
  ScanSearch,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/** Management-only type icons, using the same icon family as the navigation. */
const icons: Readonly<Record<string, LucideIcon>> = {
  explore: FileSearch,
  'local-worker': SquareTerminal,
  'browser-worker': Globe,
  'site-scout': ScanSearch,
  'browser-skill-builder': Wrench,
  'browser-skill-verifier': ListChecks,
};

export function AgentTypeIcon({ type, size = 20 }: { type: string; size?: number }) {
  const Icon = (Object.hasOwn(icons, type) ? icons[type] : undefined) ?? Bot;
  return <Icon size={size} aria-hidden="true" focusable="false" />;
}
