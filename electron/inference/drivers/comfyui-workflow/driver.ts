import { createUuid } from '@shared/utils/identifiers.js';
import { z } from 'zod';
import type { ArtifactPayload, ArtifactStore } from '../../execution/artifact-port.js';
import { GatewayCallError, isGatewayCallError, localCallError } from '../../execution/call-error.js';
import type { AttemptContext, ModelTarget } from '../../execution/contracts.js';
import {
  ComfyWorkflowAssetStore,
  WorkflowAssetError,
  type ComfyWorkflow,
} from '../../control/workflow-assets.js';
import type { ImageRequest } from '../../image/contracts.js';
import { toImageArtifact } from '../../image/artifact-store.js';
import { ImageSubmissionError, type ImageAttemptEvent, type ImageResumeInput } from '../../image/driver-port.js';
import type {
  DriverCompileInput,
  DriverValidationIssue,
  InferenceDriver,
  ProbeReceipt,
  ProviderConnectivityProbeInput,
} from '../contracts.js';
import { ComfyHttpClient, type ComfyCallContext, type ComfyConnection } from './http-client.js';
import { inspectImage } from './image-inspection.js';
import {
  comfyModelOptionsSchema,
  comfyProviderOptionsSchema,
  type ComfyModelOptions,
} from './options.js';
import {
  projectComfyHistory,
  projectComfyPreview,
  projectComfySocketMessage,
  type ComfyHistoryState,
} from './protocol-projector.js';
import {
  ComfySerializationError,
  materializeComfyRequest,
  planComfyRequest,
} from './request-mapper.js';
import {
  ComfySocketSession,
  defaultComfySocketFactory,
  type ComfySocketFactory,
} from './socket-session.js';

export interface ComfyWorkflowDriverDependencies {
  workflows?: ComfyWorkflowAssetStore;
  artifacts?: ArtifactStore;
  fetch?: typeof globalThis.fetch;
  resolveFetch?: (proxyId: string | null, fallback: typeof globalThis.fetch) => typeof globalThis.fetch;
  socketFactory?: ComfySocketFactory;
  resolveSocketFactory?: (proxyId: string | null, fallback: ComfySocketFactory) => ComfySocketFactory;
  uuid?: () => string;
  now?: () => Date;
}

interface CompiledComfyTarget {
  target: ModelTarget;
  connection: ComfyConnection;
  options: ComfyModelOptions;
  workflow: ComfyWorkflow;
  pollIntervalMs: number;
  artifacts: ArtifactStore;
  fetch: typeof globalThis.fetch;
  socketFactory: ComfySocketFactory;
  uuid: () => string;
}

interface ComfyDriverState {
  clientId: string;
  seed?: number;
}

export function createComfyWorkflowDriver(
  dependencies: ComfyWorkflowDriverDependencies = {},
): InferenceDriver {
  const baseFetch = dependencies.fetch ?? globalThis.fetch;
  const socketFactory = dependencies.socketFactory ?? defaultComfySocketFactory;
  const uuid = dependencies.uuid ?? createUuid;
  const now = dependencies.now ?? (() => new Date());

  return {
    manifest: {
      id: 'comfyui-workflow',
      supportedGateways: ['image'],
      acceptedAuth: ['none', 'bearer', 'api_key', 'basic'],
      providerConfigSchema: z.toJSONSchema(comfyProviderOptionsSchema) as Record<string, unknown>,
      modelOptionsSchema: z.toJSONSchema(comfyModelOptionsSchema) as Record<string, unknown>,
    },
    validateProviderOptions: (options) => zodIssues(comfyProviderOptionsSchema.safeParse(options)),
    validateModelOptions: (options) => validateModelOptions(options, dependencies.workflows),
    compile: (input) => compileTarget(input, {
      workflows: dependencies.workflows,
      artifacts: dependencies.artifacts,
      fetch: baseFetch,
      socketFactory,
      resolveFetch: dependencies.resolveFetch,
      resolveSocketFactory: dependencies.resolveSocketFactory,
      uuid,
    }),
    probeConnectivity: (input) => probeConnectivity(input, {
      fetch: baseFetch,
      resolveFetch: dependencies.resolveFetch,
      now,
    }),
  };
}

function compileTarget(
  input: DriverCompileInput,
  dependencies: Required<Pick<ComfyWorkflowDriverDependencies, 'fetch' | 'socketFactory' | 'uuid'>>
    & Pick<ComfyWorkflowDriverDependencies, 'workflows' | 'artifacts' | 'resolveFetch' | 'resolveSocketFactory'>,
) {
  if (input.catalogModel.kind !== 'image') {
    throw new Error('ComfyUI workflow Driver can only compile Image models');
  }
  if (!dependencies.workflows || !dependencies.artifacts) {
    throw new Error('ComfyUI workflow Driver requires Workflow and Artifact stores');
  }
  const providerOptions = comfyProviderOptionsSchema.parse(input.provider.driverOptions);
  const options = comfyModelOptionsSchema.parse(input.binding.options);
  const asset = dependencies.workflows.readSync(options.workflowAssetId);
  const report = dependencies.workflows.validateBindings(
    options.workflowAssetId,
    options.bindings,
    options.outputNodeIds,
  );
  if (!report.valid) {
    throw new WorkflowAssetError(
      'WORKFLOW_BINDINGS_INVALID',
      `ComfyUI bindings are invalid for ${options.workflowAssetId}`,
      { issues: report.issues },
    );
  }
  const proxyId = input.provider.connection.proxyId;
  const compiled: CompiledComfyTarget = {
    target: { providerId: input.providerId, modelId: input.modelId },
    connection: compileConnection(input.provider.connection),
    options,
    workflow: structuredClone(asset.workflow),
    pollIntervalMs: providerOptions.historyPollIntervalMs,
    artifacts: dependencies.artifacts,
    fetch: dependencies.resolveFetch?.(proxyId, dependencies.fetch) ?? dependencies.fetch,
    socketFactory: dependencies.resolveSocketFactory?.(proxyId, dependencies.socketFactory)
      ?? dependencies.socketFactory,
    uuid: dependencies.uuid,
  };
  return {
    ref: compiled.target,
    driverId: 'comfyui-workflow',
    upstreamModel: input.binding.upstreamId,
    catalogId: input.binding.catalogId,
    configRevision: input.configRevision,
    image: {
      mode: 'job' as const,
      submit: (request: ImageRequest, context: AttemptContext) => submitComfyRequest(compiled, request, context),
      resume: (resume: ImageResumeInput, context: AttemptContext) => resumeComfyRequest(compiled, resume, context),
    },
  };
}

async function* submitComfyRequest(
  compiled: CompiledComfyTarget,
  request: ImageRequest,
  context: AttemptContext,
): AsyncIterable<ImageAttemptEvent> {
  const client = new ComfyHttpClient(compiled.connection, compiled.fetch);
  const callContext = { target: compiled.target, attempt: context };
  let plan: ReturnType<typeof planComfyRequest>;
  let sources: ArtifactPayload[] = [];
  let mask: ArtifactPayload | undefined;
  try {
    plan = planComfyRequest(request, compiled.options);
    if (request.operation.kind === 'edit') {
      [sources, mask] = await Promise.all([
        Promise.all(request.operation.sources.map((ref) => compiled.artifacts.read(ref, context.signal))),
        request.operation.mask ? compiled.artifacts.read(request.operation.mask, context.signal) : undefined,
      ]);
    }
  } catch (cause) {
    throw localSubmissionError(cause, compiled.target, context, 'serialize');
  }

  const uploadedSources: string[] = [];
  for (const [index, source] of sources.entries()) {
    uploadedSources.push(await client.upload(source, uploadFileName(source, `source-${index}`), callContext));
  }
  const uploadedMask = mask
    ? await client.upload(mask, uploadFileName(mask, 'mask'), callContext)
    : undefined;
  let workflow: ComfyWorkflow;
  try {
    workflow = materializeComfyRequest(
      compiled.workflow,
      request,
      compiled.options,
      plan,
      uploadedSources,
      uploadedMask,
    );
  } catch (cause) {
    throw localSubmissionError(cause, compiled.target, context, 'serialize');
  }

  const clientId = compiled.uuid();
  const receipt = await client.submit(workflow, clientId, callContext);
  const driverState: ComfyDriverState = {
    clientId,
    ...(plan.extension.seed !== undefined && { seed: plan.extension.seed }),
  };
  yield {
    kind: 'job.accepted',
    upstreamJobId: receipt.promptId,
    resumable: true,
    ...(receipt.position !== undefined && { position: receipt.position }),
    driverState,
  };
  yield* observeComfyJob(compiled, client, receipt.promptId, driverState, callContext);
}

async function* resumeComfyRequest(
  compiled: CompiledComfyTarget,
  resume: ImageResumeInput,
  context: AttemptContext,
): AsyncIterable<ImageAttemptEvent> {
  const client = new ComfyHttpClient(compiled.connection, compiled.fetch);
  const state = parseDriverState(resume.driverState, compiled.uuid);
  yield* observeComfyJob(
    compiled,
    client,
    resume.job.upstreamJobId,
    state,
    { target: compiled.target, attempt: context },
  );
}

async function* observeComfyJob(
  compiled: CompiledComfyTarget,
  client: ComfyHttpClient,
  promptId: string,
  state: ComfyDriverState,
  context: ComfyCallContext,
): AsyncIterable<ImageAttemptEvent> {
  let socket: ComfySocketSession | undefined;
  try {
    try {
      socket = new ComfySocketSession(
        compiled.socketFactory(client.socketUrl(state.clientId), client.socketHeaders()),
        context.attempt.signal,
      );
    } catch {
      socket = undefined;
    }
    let inspectHistory = true;
    while (true) {
      context.attempt.signal.throwIfAborted();
      if (inspectHistory) {
        const projected = projectComfyHistory(
          await client.history(promptId, context),
          promptId,
          compiled.options.outputNodeIds,
        );
        if (projected.kind === 'failure') throw executionError(projected, compiled.target, context.attempt, 'history');
        if (projected.kind === 'completed') {
          yield* downloadCompletedArtifacts(compiled, client, projected, state, context);
          return;
        }
        inspectHistory = false;
      }

      if (!socket) {
        await abortableDelay(compiled.pollIntervalMs, context.attempt.signal);
        inspectHistory = true;
        continue;
      }
      const item = await socket.nextWithin(compiled.pollIntervalMs, context.attempt.signal);
      if (!item) {
        inspectHistory = true;
        continue;
      }
      if (item.kind === 'closed' || item.kind === 'error' || item.kind === 'invalid_json') {
        socket.close();
        socket = undefined;
        inspectHistory = true;
        continue;
      }
      if (item.kind === 'binary') {
        const preview = projectComfyPreview(item.bytes);
        if (!preview) continue;
        const inspected = inspectImage(preview.bytes, preview.declaredMimeType);
        const stored = await writeArtifact(compiled, {
          bytes: preview.bytes,
          mimeType: inspected.mimeType,
          fileName: `comfy-preview-${safeName(promptId)}.${extensionForMime(inspected.mimeType)}`,
          metadata: {
            ...(inspected.width !== undefined && { width: inspected.width }),
            ...(inspected.height !== undefined && { height: inspected.height }),
            ...(state.seed !== undefined && { seed: state.seed }),
          },
        }, context.attempt, 'preview_store');
        yield { kind: 'preview', artifact: toImageArtifact(stored) };
        continue;
      }
      const projected = projectComfySocketMessage(item.value, promptId);
      if (projected.kind === 'progress') {
        yield {
          kind: 'progress',
          value: projected.value,
          ...(projected.message && { message: projected.message }),
        };
      } else if (projected.kind === 'terminal') {
        inspectHistory = true;
      } else if (projected.kind === 'failure') {
        throw executionError(projected, compiled.target, context.attempt, 'execution');
      }
    }
  } finally {
    socket?.close();
  }
}

async function* downloadCompletedArtifacts(
  compiled: CompiledComfyTarget,
  client: ComfyHttpClient,
  history: Extract<ComfyHistoryState, { kind: 'completed' }>,
  state: ComfyDriverState,
  context: ComfyCallContext,
): AsyncIterable<ImageAttemptEvent> {
  for (const reference of history.files) {
    const payload = await client.download(reference, context);
    const inspected = inspectImage(payload.bytes, payload.mimeType);
    const stored = await writeArtifact(compiled, {
      ...payload,
      mimeType: inspected.mimeType,
      metadata: {
        ...(inspected.width !== undefined && { width: inspected.width }),
        ...(inspected.height !== undefined && { height: inspected.height }),
        ...(state.seed !== undefined && { seed: state.seed }),
      },
    }, context.attempt, 'artifact_store');
    yield { kind: 'artifact', artifact: toImageArtifact(stored) };
  }
  yield { kind: 'completed', usage: { imageCount: history.files.length } };
}

async function writeArtifact(
  compiled: CompiledComfyTarget,
  input: Parameters<ArtifactStore['write']>[0],
  context: Pick<AttemptContext, 'attempt' | 'traceId' | 'signal'>,
  stage: string,
) {
  try {
    return await compiled.artifacts.write(input, context.signal);
  } catch (cause) {
    throw localCallError({
      gateway: 'image',
      target: compiled.target,
      driverId: 'comfyui-workflow',
      stage,
      attempt: context.attempt,
      traceId: context.traceId,
      localCode: errorCode(cause, 'COMFYUI_ARTIFACT_WRITE_FAILED'),
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }
}

function executionError(
  failure: { message: string; body: unknown; type?: string },
  target: ModelTarget,
  context: Pick<AttemptContext, 'attempt' | 'traceId'>,
  stage: string,
): GatewayCallError {
  return new GatewayCallError({
    source: 'provider',
    gateway: 'image',
    providerId: target.providerId,
    modelId: target.modelId,
    driverId: 'comfyui-workflow',
    stage,
    attempt: context.attempt,
    traceId: context.traceId,
    message: failure.message,
    upstream: {
      ...(failure.type && { type: failure.type }),
      message: failure.message,
      body: failure.body,
    },
  });
}

function localSubmissionError(
  cause: unknown,
  target: ModelTarget,
  context: Pick<AttemptContext, 'attempt' | 'traceId'>,
  stage: string,
): ImageSubmissionError {
  return new ImageSubmissionError({
    source: 'local',
    gateway: 'image',
    providerId: target.providerId,
    modelId: target.modelId,
    driverId: 'comfyui-workflow',
    stage,
    attempt: context.attempt,
    traceId: context.traceId,
    message: cause instanceof Error ? cause.message : String(cause),
    localCode: errorCode(cause, cause instanceof ComfySerializationError
      ? cause.code
      : 'COMFYUI_INPUT_READ_FAILED'),
  }, 'not_accepted', false, { cause });
}

async function probeConnectivity(
  input: ProviderConnectivityProbeInput,
  dependencies: Required<Pick<ComfyWorkflowDriverDependencies, 'fetch' | 'now'>>
    & Pick<ComfyWorkflowDriverDependencies, 'resolveFetch'>,
): Promise<ProbeReceipt> {
  const startedAt = dependencies.now().toISOString();
  const target = { providerId: input.providerId, modelId: 'connectivity' };
  const context: AttemptContext = {
    runId: `probe:${input.providerId}`,
    traceId: `probe:${input.providerId}`,
    signal: input.signal,
    attempt: 1,
    configRevision: 0,
    connectTimeoutMs: 30_000,
  };
  try {
    const connection = compileConnection(input.provider.connection);
    const proxyId = input.provider.connection.proxyId;
    const resolvedFetch = dependencies.resolveFetch?.(proxyId, dependencies.fetch) ?? dependencies.fetch;
    const client = new ComfyHttpClient(connection, resolvedFetch);
    await client.systemStats(input.signal, { target, attempt: context });
    return {
      driverId: 'comfyui-workflow',
      providerId: input.providerId,
      level: 'connectivity',
      success: true,
      startedAt,
      completedAt: dependencies.now().toISOString(),
    };
  } catch (cause) {
    const error = isGatewayCallError(cause) ? cause.toJSON() : serializeError(cause);
    return {
      driverId: 'comfyui-workflow',
      providerId: input.providerId,
      level: 'connectivity',
      success: false,
      startedAt,
      completedAt: dependencies.now().toISOString(),
      ...((cause instanceof GatewayCallError && cause.upstream?.status !== undefined)
        && { status: cause.upstream.status }),
      error,
    };
  }
}

function compileConnection(connection: DriverCompileInput['provider']['connection']): ComfyConnection {
  const headers: Record<string, string> = { ...connection.headers };
  if (connection.auth.kind === 'bearer') headers.authorization = `Bearer ${connection.auth.value}`;
  if (connection.auth.kind === 'api_key') headers[connection.auth.header] = connection.auth.value;
  if (connection.auth.kind === 'basic') {
    headers.authorization = `Basic ${Buffer.from(`${connection.auth.username}:${connection.auth.password}`).toString('base64')}`;
  }
  return { baseUrl: connection.baseUrl.replace(/\/+$/, ''), headers };
}

function uploadFileName(payload: ArtifactPayload, fallback: string): string {
  const candidate = payload.fileName?.split(/[\\/]/).pop()?.replace(/[^A-Za-z0-9._-]/g, '_');
  if (candidate) return candidate;
  return `${fallback}.${extensionForMime(payload.mimeType)}`;
}

function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'job';
}

function parseDriverState(value: unknown, uuid: () => string): ComfyDriverState {
  if (!isRecord(value) || typeof value.clientId !== 'string') return { clientId: uuid() };
  return {
    clientId: value.clientId,
    ...(typeof value.seed === 'number' && { seed: value.seed }),
  };
}

function zodIssues(result: z.ZodSafeParseResult<unknown>): readonly DriverValidationIssue[] {
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    path: issue.path.length ? `/${issue.path.map(String).join('/')}` : '',
    code: 'COMFYUI_OPTIONS_INVALID',
    message: issue.message,
  }));
}

function validateModelOptions(
  raw: Readonly<Record<string, unknown>>,
  workflows: ComfyWorkflowAssetStore | undefined,
): readonly DriverValidationIssue[] {
  const parsed = comfyModelOptionsSchema.safeParse(raw);
  const schemaIssues = zodIssues(parsed);
  if (!parsed.success || !workflows) return schemaIssues;
  try {
    workflows.readSync(parsed.data.workflowAssetId);
    const report = workflows.validateBindings(
      parsed.data.workflowAssetId,
      parsed.data.bindings,
      parsed.data.outputNodeIds,
    );
    return report.issues.map((issue) => ({
      path: issue.path,
      code: issue.code,
      message: issue.message,
    }));
  } catch (cause) {
    return [{
      path: '/workflowAssetId',
      code: errorCode(cause, 'WORKFLOW_ASSET_INVALID'),
      message: cause instanceof Error ? cause.message : String(cause),
    }];
  }
}

function errorCode(error: unknown, fallback: string): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : fallback;
}

function serializeError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  return {
    name: error.name,
    message: error.message,
    ...('code' in error && typeof error.code === 'string' && { code: error.code }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
