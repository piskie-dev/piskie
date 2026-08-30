import { PublicOperationError } from '../../capabilities/public-errors.js';
import type {
  ControllerCatalog,
  ControllerContext,
  OperationDefinition,
  TopicDefinition,
  TopicOpenResult,
} from '../../capabilities/catalog.js';

export interface RuntimeGate {
  phase(): 'ready' | 'stopping' | 'closed';
}

export class PortRouter {
  constructor(
    private readonly catalog: ControllerCatalog,
    private readonly runtime: RuntimeGate,
  ) {}

  capabilities() {
    return this.catalog.capabilities;
  }

  async request(
    context: ControllerContext,
    operationId: string,
    payload: unknown,
  ): Promise<unknown> {
    const operation = this.catalog.operations.get(operationId);
    if (!operation) {
      throw new PublicOperationError('unsupported', `Unknown operation: ${operationId}`);
    }
    const phase = this.runtime.phase();
    if (phase !== 'ready' && !(phase === 'stopping' && operation.allowDuringStopping)) {
      throw new PublicOperationError('not-ready', 'Backend is not accepting commands', {
        retryable: false,
      });
    }
    const input = decode(operation, payload);
    return operation.execute(context, input);
  }

  async subscribe(
    context: ControllerContext,
    topicId: string,
    payload: unknown,
    emit: (change: unknown) => void,
  ): Promise<TopicOpenResult> {
    if (this.runtime.phase() !== 'ready') {
      throw new PublicOperationError('not-ready', 'Backend is not accepting subscriptions');
    }
    const topic = this.catalog.topics.get(topicId);
    if (!topic) throw new PublicOperationError('unsupported', `Unknown topic: ${topicId}`);
    const input = decode(topic, payload);
    return topic.open(context, input, emit);
  }
}

function decode<T>(
  definition: OperationDefinition<T> | TopicDefinition<T>,
  payload: unknown,
): T {
  const parsed = definition.input.safeParse(payload);
  if (parsed.success) return parsed.data;
  throw new PublicOperationError('invalid-input', 'Request payload is invalid', {
    details: {
      issues: parsed.error.issues
        .slice(0, 12)
        .map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`)
        .join('; '),
    },
  });
}
