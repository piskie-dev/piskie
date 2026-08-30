import { z } from 'zod';
import {
  PILOT_OPERATIONS,
  PILOT_TOPICS,
} from '../../../shared/electron-contracts/pilot.js';
import type {
  BrowserEnvironment,
  CreateBrowserEnvironmentRequest,
} from '../../../shared/types/index.js';
import type { ScreenStreamRequest } from '../../../shared/types/stream.js';
import {
  streamTransfer,
  type ControllerContext,
  type OperationDefinition,
  type TopicDefinition,
} from '../catalog.js';
import { args, identifier, plainRecord } from '../validation.js';
import type { PilotApplication } from './pilot-application.js';

const identityPolicySchema = z.object({
  platform: z.enum(['macos', 'windows', 'linux']).optional(),
  userAgent: z.string().max(16_384).optional(),
  timezone: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('ip') }).strict(),
    z.object({ mode: z.literal('real') }).strict(),
    z.object({ mode: z.literal('custom'), value: z.string().min(1).max(512) }).strict(),
  ]),
  geolocation: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('ip') }).strict(),
    z.object({ mode: z.literal('off') }).strict(),
    z.object({
      mode: z.literal('custom'),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracy: z.number().positive().optional(),
    }).strict(),
  ]),
  language: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('ip') }).strict(),
    z.object({ mode: z.literal('custom'), value: z.string().min(1).max(128) }).strict(),
  ]),
  hardwareConcurrency: z.number().int().min(1).max(256).optional(),
  extra: plainRecord.optional(),
}).strict();
const environmentInputSchema = z.object({
  name: identifier,
  purpose: z.string().max(200).optional(),
  groupId: identifier.optional(),
  platform: z.string().max(128).optional(),
  identityPolicy: identityPolicySchema.optional(),
  proxyId: identifier.optional(),
  extensionIds: z.array(identifier).max(256).optional(),
}).strict();
const environmentUpdateSchema = environmentInputSchema.partial();
const boundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
}).strict();
const pathSchema = z.string().trim().min(1).max(16_384);
const streamRequestSchema = z.object({
  requestId: identifier,
  kind: z.literal('browser').optional(),
  browserId: identifier,
  fps: z.number().min(1).max(60).optional(),
  quality: z.number().int().min(1).max(100).optional(),
  maxWidth: z.number().int().min(1).max(16_384).optional(),
  maxHeight: z.number().int().min(1).max(16_384).optional(),
}).strict();
export function createPilotController(
  application: PilotApplication,
): { operations: readonly OperationDefinition[]; topics: readonly TopicDefinition[] } {
  const operations: OperationDefinition[] = [
    operation(PILOT_OPERATIONS.listEnvironments, args([]), () => application.listEnvironments()),
    operation(PILOT_OPERATIONS.getEnvironment, args([identifier]), (_context, [environmentId]) => (
      application.getEnvironment(environmentId)
    )),
    operation(PILOT_OPERATIONS.createEnvironment, args([environmentInputSchema]), (_context, [input]) => (
      application.createEnvironment(input as CreateBrowserEnvironmentRequest)
    )),
    operation(PILOT_OPERATIONS.updateEnvironment, args([identifier, environmentUpdateSchema]), (_context, [id, updates]) => (
      application.updateEnvironment(id, updates as Partial<BrowserEnvironment>)
    )),
    operation(PILOT_OPERATIONS.deleteEnvironment, args([identifier]), (_context, [environmentId]) => (
      application.deleteEnvironment(environmentId)
    )),
    operation(PILOT_OPERATIONS.listEnvironmentGroups, args([]), () => application.listGroups()),
    operation(PILOT_OPERATIONS.createEnvironmentGroup, args([identifier]), (_context, [name]) => (
      application.createGroup(name)
    )),
    operation(PILOT_OPERATIONS.deleteEnvironmentGroup, args([identifier]), (_context, [groupId]) => (
      application.deleteGroup(groupId)
    )),
    operation(PILOT_OPERATIONS.startEnvironment, args([identifier]), (_context, [environmentId]) => (
      application.startEnvironment(environmentId)
    )),
    operation(PILOT_OPERATIONS.stopEnvironment, args([identifier]), (_context, [environmentId]) => (
      application.stopEnvironment(environmentId)
    )),
    operation(PILOT_OPERATIONS.showEnvironmentWindow, args([identifier]), (_context, [environmentId]) => (
      application.showEnvironmentWindow(environmentId)
    )),
    operation(PILOT_OPERATIONS.captureEnvironmentLoginTrail, args([identifier]), (_context, [environmentId]) => (
      application.captureLoginTrail(environmentId)
    )),
    operation(PILOT_OPERATIONS.kernelStatus, args([]), () => application.kernelStatus()),
    operation(PILOT_OPERATIONS.installKernel, args([]), () => application.installKernel()),
    operation(
      PILOT_OPERATIONS.screenSnapshot,
      args([identifier, z.number().int().min(1).max(100).optional()]),
      (_context, [browserId, quality]) => application.screenSnapshot(browserId, quality),
    ),
    operation(PILOT_OPERATIONS.showScreen, args([identifier]), (_context, [browserId]) => (
      application.showScreen(browserId)
    )),
    operation(PILOT_OPERATIONS.requestScreenStream, args([streamRequestSchema]), async (_context, [request]) => {
      const port = await application.requestScreenStream(request as ScreenStreamRequest);
      return streamTransfer(port, {
        requestId: request.requestId,
        browserId: request.browserId,
      });
    }),
    operation(PILOT_OPERATIONS.navigateEmbeddedBrowser, args([z.string().max(8_192)]), (context, [url]) => (
      application.navigateEmbeddedBrowser(context.windowId, url)
    )),
    operation(PILOT_OPERATIONS.openLocalHtmlInEmbeddedBrowser, args([pathSchema]), (context, [targetPath]) => (
      application.openLocalHtmlInEmbeddedBrowser(context.windowId, targetPath)
    )),
    operation(PILOT_OPERATIONS.backEmbeddedBrowser, args([]), (context) => (
      application.embeddedBrowser(context.windowId).back()
    )),
    operation(PILOT_OPERATIONS.forwardEmbeddedBrowser, args([]), (context) => (
      application.embeddedBrowser(context.windowId).forward()
    )),
    operation(PILOT_OPERATIONS.reloadEmbeddedBrowser, args([]), (context) => (
      application.embeddedBrowser(context.windowId).reload()
    )),
    operation(PILOT_OPERATIONS.stopEmbeddedBrowser, args([]), (context) => (
      application.embeddedBrowser(context.windowId).stop()
    )),
    operation(PILOT_OPERATIONS.setEmbeddedBrowserBounds, args([boundsSchema]), (context, [bounds]) => (
      application.embeddedBrowser(context.windowId).setBounds(bounds)
    )),
    operation(PILOT_OPERATIONS.setEmbeddedBrowserVisible, args([z.boolean()]), (context, [visible]) => (
      application.embeddedBrowser(context.windowId).setVisible(visible)
    )),
    operation(PILOT_OPERATIONS.embeddedBrowserState, args([]), (context) => (
      application.embeddedBrowser(context.windowId).state()
    )),
  ];

  const topics: TopicDefinition[] = [
    {
      id: PILOT_TOPICS.kernel,
      capability: 'pilot',
      input: z.undefined(),
      open(_context, _input, emit) {
        return {
          snapshot: application.kernelStatus(),
          dispose: application.subscribeKernel(emit),
        };
      },
    },
    {
      id: PILOT_TOPICS.embeddedBrowser,
      capability: 'pilot',
      input: z.undefined(),
      open(context, _input, emit) {
        const browser = application.embeddedBrowser(context.windowId);
        const dispose = browser.changes.subscribe(emit, { signal: context.signal });
        return { snapshot: browser.state(), dispose };
      },
    },
  ];

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
  return {
    id,
    capability: 'pilot',
    input,
    execute,
  };
}
