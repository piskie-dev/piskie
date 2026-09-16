import {
  Activity, ArrowUpRight, BookOpen, Bot, Camera, CircleHelp, ClipboardList,
  CloudUpload, FileDiff, FilePen, FilePlus2, FileSearch, FileText, FolderOpen,
  FolderSearch, Globe, Hammer, Hourglass, ImagePlus, ListChecks, Puzzle, Search,
  Smartphone, Terminal, Workflow, Wrench,
} from 'lucide-react';
import type { PlanNode, ToolNode } from '@/domains/transcript/nodes';
import { isBrowserToolName } from '../data/cells/toolPresentation';

export function ToolTypeIcon({ cell, size = 14 }: {
  readonly cell: ToolNode | PlanNode;
  readonly size?: number;
}) {
  if (cell.kind === 'plan') return <FileDiff size={size} />;
  const tool = cell.tool;
  switch (tool) {
    case 'read': return <FileText size={size} />;
    case 'write': return <FilePlus2 size={size} />;
    case 'edit': return <FilePen size={size} />;
    case 'ls': return <FolderOpen size={size} />;
    case 'glob': return <FolderSearch size={size} />;
    case 'grep': return <FileSearch size={size} />;
    case 'shell': return <Terminal size={size} />;
    case 'task': return <ListChecks size={size} />;
    case 'plan': return <ClipboardList size={size} />;
    case 'ask_user': return <CircleHelp size={size} />;
    case 'subagent':
    case 'subagent_stop': return <Workflow size={size} />;
    case 'skill_call': return <Puzzle size={size} />;
    case 'load_skill': return <BookOpen size={size} />;
    case 'tool_search':
    case 'web_search': return <Search size={size} />;
    case 'agent_run': return <Bot size={size} />;
    case 'browser_skill_build': return <Hammer size={size} />;
    case 'browser_skill_status': return <Activity size={size} />;
    case 'browser_skill_publish': return <CloudUpload size={size} />;
    case 'generate_image': return <ImagePlus size={size} />;
    case 'wait': return <Hourglass size={size} />;
    case 'send_event': return <ArrowUpRight size={size} />;
    default:
      if (/screenshot/i.test(tool)) return <Camera size={size} />;
      if (tool.startsWith('mobile-core')) return <Smartphone size={size} />;
      if (isBrowserToolName(tool)) return <Globe size={size} />;
      if (/write|edit|patch|apply/i.test(tool)) return <FilePen size={size} />;
      return <Wrench size={size} />;
  }
}
