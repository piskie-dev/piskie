import { Bot, Chrome, ClipboardList, Image, MessagesSquare, Network, Plug, Puzzle, Sparkles } from 'lucide-react';

export const GUIDE_IDS = ['model-setup', 'getting-started', 'agents', 'browser', 'extensions', 'messaging', 'templates', 'mcp', 'proxy', 'image'] as const;
export type GuideId = typeof GUIDE_IDS[number];
export const GUIDE_ICONS = {
  'model-setup': Bot, 'getting-started': Sparkles, browser: Chrome, extensions: Puzzle,
  messaging: MessagesSquare, templates: ClipboardList, mcp: Plug, proxy: Network, image: Image, agents: Bot,
} as const;
