import type {
  ConfigApplyReceipt,
  ConfigDescriptor,
  ConfigFieldChange,
  ConfigPlanRequest,
  ConfigVerificationReport,
} from '../../../shared/types/config';
import type { ConfigPlanSnapshot } from '../../../shared/electron-contracts/configuration';

interface ConfigFieldTarget {
  pathTemplate: string;
  bindings?: Readonly<Record<string, string | number>>;
  extensionId?: string;
}

export type ConfigFieldMutation =
  | (ConfigFieldTarget & { op: 'set'; value: unknown })
  | (ConfigFieldTarget & { op: 'remove' });

export interface ConfigTransactionResult {
  plan: ConfigPlanSnapshot;
  receipt: ConfigApplyReceipt;
  verification: ConfigVerificationReport;
}

export function createConfigPlanRequest(
  descriptor: ConfigDescriptor,
  mutations: readonly ConfigFieldMutation[],
): ConfigPlanRequest {
  if (mutations.length === 0) throw new Error('Config transaction requires at least one field change');
  return {
    descriptorHash: descriptor.descriptorHash,
    changes: mutations.map((mutation) => bindField(descriptor, mutation)),
  };
}

export async function applyConfigFieldChanges(
  domain: string,
  descriptor: ConfigDescriptor,
  expectedRevision: number,
  mutations: readonly ConfigFieldMutation[],
): Promise<ConfigTransactionResult> {
  if (descriptor.domain !== domain) {
    throw new Error(`Config descriptor ${descriptor.domain} cannot be used for ${domain}`);
  }

  const identity = await window.piskie.configuration.plan(
    domain,
    createConfigPlanRequest(descriptor, mutations),
  );

  const plan = await window.piskie.configuration.validate(identity.id);
  if (!plan.validation.valid) {
    throw new Error(plan.validation.issues
      .map((issue) => `${issue.path || '/'}: ${issue.message}`)
      .join('\n'));
  }

  const receipt = await window.piskie.configuration.apply(identity.id, expectedRevision);
  const verification = await window.piskie.configuration.verify<ConfigVerificationReport>(
    domain,
    receipt.revision,
  );
  if (!verification.healthy) {
    const details = verification.issues.map((issue) => issue.message).join('\n');
    throw new Error(details || `${domain} config was written but runtime verification failed`);
  }

  return { plan, receipt, verification };
}

function bindField(
  descriptor: ConfigDescriptor,
  mutation: ConfigFieldMutation,
): ConfigFieldChange {
  const candidates = descriptor.fields.filter((field) => (
    field.pathTemplate === mutation.pathTemplate
    && (mutation.extensionId === undefined
      ? field.source === 'domain'
      : field.extensionId === mutation.extensionId)
  ));
  if (candidates.length !== 1) {
    const extension = mutation.extensionId ? ` in extension ${mutation.extensionId}` : '';
    throw new Error(
      `Expected one config field ${mutation.pathTemplate}${extension} in ${descriptor.domain}; found ${candidates.length}`,
    );
  }

  const field = candidates[0]!;
  if (field.mutability !== 'write' && field.mutability !== 'create-only') {
    throw new Error(`Config field ${mutation.pathTemplate} is not writable`);
  }
  const target = {
    fieldId: field.fieldId,
    ...(mutation.bindings && { bindings: mutation.bindings }),
  };
  return mutation.op === 'remove'
    ? { op: 'remove', ...target }
    : { op: 'set', ...target, value: mutation.value };
}
