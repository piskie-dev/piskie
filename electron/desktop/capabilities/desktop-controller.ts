import { z } from 'zod';
import {
  DESKTOP_OPERATIONS,
  DESKTOP_TOPICS,
} from '../../../shared/electron-contracts/desktop.js';
import type {
  ControllerContext,
  OperationDefinition,
  TopicDefinition,
} from '../../capabilities/catalog.js';
import { args, identifier } from '../../capabilities/validation.js';
import type { DesktopApplication } from './desktop-application.js';

const pathSchema = z.string().trim().min(1).max(16_384);

export function createDesktopController(
  application: DesktopApplication,
): { operations: readonly OperationDefinition[]; topics: readonly TopicDefinition[] } {
  const operations: OperationDefinition[] = [
    operation(DESKTOP_OPERATIONS.info, args([]), () => application.info()),
    operation(DESKTOP_OPERATIONS.openDevTools, args([]), (context) => (
      application.openDevTools(context.windowId)
    )),
    operation(DESKTOP_OPERATIONS.openExternal, args([z.string().max(8_192)]), (_context, [url]) => (
      application.openExternal(url)
    )),
    operation(DESKTOP_OPERATIONS.openPath, args([pathSchema]), (_context, [targetPath]) => (
      application.openPath(targetPath)
    )),
    operation(DESKTOP_OPERATIONS.revealPath, args([pathSchema]), (_context, [targetPath]) => (
      application.revealPath(targetPath)
    )),
    operation(
      DESKTOP_OPERATIONS.openWorkspace,
      args([pathSchema.optional()]),
      (_context, [workspace]) => application.openWorkspace(workspace),
    ),
    operation(DESKTOP_OPERATIONS.openAgentRunTrace, args([identifier]), (_context, [agentId]) => (
      application.openAgentRunTrace(agentId)
    )),
    operation(DESKTOP_OPERATIONS.clipboardAttachments, args([]), (context) => (
      application.clipboardAttachments(context.windowId)
    )),
    operation(DESKTOP_OPERATIONS.previewFile, args([pathSchema]), (context, [targetPath]) => (
      application.previewFile(context.windowId, targetPath)
    )),
    operation(
      DESKTOP_OPERATIONS.selectFiles,
      args([z.object({ type: z.enum(['file', 'folder', 'any']).optional() }).strict().optional()]),
      (context, [input]) => application.selectFiles(context.windowId, input?.type),
    ),
    operation(DESKTOP_OPERATIONS.pickBackground, args([]), (context) => (
      application.pickBackground(context.windowId)
    )),
    operation(DESKTOP_OPERATIONS.clearBackground, args([]), () => application.clearBackground()),
    operation(
      DESKTOP_OPERATIONS.setColorScheme,
      args([z.enum(['light', 'dark'])]),
      (_context, [colorScheme]) => application.setColorScheme(colorScheme),
    ),
  ];
  const topics: TopicDefinition[] = [{
    id: DESKTOP_TOPICS.network,
    capability: 'desktop',
    input: z.undefined(),
    open(_context, _input, emit) {
      return {
        snapshot: application.networkStatus(),
        dispose: application.observeNetwork(emit),
      };
    },
  }];
  return Object.freeze({
    operations: Object.freeze(operations),
    topics: Object.freeze(topics),
  });
}

function operation(
  id: string,
  input: z.ZodType<unknown[]>,
  execute: (context: ControllerContext, input: any[]) => unknown,
): OperationDefinition<unknown[]> {
  return { id, capability: 'desktop', input, execute };
}
