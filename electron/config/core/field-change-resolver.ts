import type {
  ConfigDescriptor,
  ConfigFieldBindingDescriptor,
  ConfigFieldChange,
  ConfigFieldDescriptor,
  ConfigPatchOperation,
  ConfigPlanRequest,
} from '../../../shared/types/config.js';

export class ConfigFieldChangeError extends Error {
  constructor(
    readonly code:
      | 'CONFIG_CHANGE_INVALID'
      | 'CONFIG_DESCRIPTOR_CHANGED'
      | 'CONFIG_FIELD_NOT_FOUND'
      | 'CONFIG_FIELD_NOT_WRITABLE'
      | 'CONFIG_FIELD_BINDINGS_INVALID'
      | 'CONFIG_CHANGE_TARGET_DUPLICATE',
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ConfigFieldChangeError';
  }
}

export function resolveConfigFieldChanges(
  descriptor: ConfigDescriptor,
  rawRequest: unknown,
): ConfigPatchOperation[] {
  const request = parseRequest(rawRequest);
  if (request.descriptorHash !== descriptor.descriptorHash) {
    throw new ConfigFieldChangeError(
      'CONFIG_DESCRIPTOR_CHANGED',
      `Config descriptor changed for ${descriptor.domain}; discover the current fields again`,
      {
        domain: descriptor.domain,
        requestedDescriptorHash: request.descriptorHash,
        currentDescriptorHash: descriptor.descriptorHash,
      },
    );
  }

  const fields = new Map(descriptor.fields.map((field) => [field.fieldId, field]));
  const targets = new Set<string>();
  return request.changes.map((change, index) => {
    const field = fields.get(change.fieldId);
    if (!field) {
      throw new ConfigFieldChangeError(
        'CONFIG_FIELD_NOT_FOUND',
        `Field ID is not present in the current ${descriptor.domain} descriptor`,
        { domain: descriptor.domain, fieldId: change.fieldId, changeIndex: index },
      );
    }
    if (field.mutability !== 'write' && field.mutability !== 'create-only') {
      throw new ConfigFieldChangeError(
        'CONFIG_FIELD_NOT_WRITABLE',
        `Config field is not writable: ${field.fieldId}`,
        {
          domain: descriptor.domain,
          fieldId: field.fieldId,
          pathTemplate: field.pathTemplate,
          mutability: field.mutability,
          changeIndex: index,
        },
      );
    }

    const path = resolvePath(field, change.bindings, index, descriptor.domain);
    if (targets.has(path)) {
      throw new ConfigFieldChangeError(
        'CONFIG_CHANGE_TARGET_DUPLICATE',
        `Multiple changes target the same config field: ${path}`,
        { domain: descriptor.domain, path, changeIndex: index },
      );
    }
    targets.add(path);

    if (change.op === 'remove') return { op: 'remove', path };
    return {
      op: finalBinding(field)?.kind === 'array-index' ? 'replace' : 'add',
      path,
      value: structuredClone(change.value),
    };
  });
}

function parseRequest(raw: unknown): ConfigPlanRequest {
  if (!isRecord(raw)) throw invalidRequest('Plan request must be a JSON object');
  assertKeys(raw, ['descriptorHash', 'changes'], 'Plan request');
  if (typeof raw.descriptorHash !== 'string' || !raw.descriptorHash) {
    throw invalidRequest('Plan request descriptorHash must be a non-empty string');
  }
  if (!Array.isArray(raw.changes) || raw.changes.length === 0) {
    throw invalidRequest('Plan request changes must be a non-empty array');
  }
  return {
    descriptorHash: raw.descriptorHash,
    changes: raw.changes.map(parseChange),
  };
}

function parseChange(raw: unknown, index: number): ConfigFieldChange {
  if (!isRecord(raw)) throw invalidRequest(`Config change ${index} must be a JSON object`);
  if (raw.op !== 'set' && raw.op !== 'remove') {
    throw invalidRequest(`Config change ${index} op must be set or remove`);
  }
  assertKeys(
    raw,
    raw.op === 'set' ? ['op', 'fieldId', 'bindings', 'value'] : ['op', 'fieldId', 'bindings'],
    `Config change ${index}`,
  );
  if (typeof raw.fieldId !== 'string' || !raw.fieldId) {
    throw invalidRequest(`Config change ${index} fieldId must be a non-empty string`);
  }
  const bindings = parseBindings(raw.bindings, index);
  if (raw.op === 'remove') return { op: 'remove', fieldId: raw.fieldId, ...(bindings && { bindings }) };
  if (!Object.hasOwn(raw, 'value')) throw invalidRequest(`Config change ${index} requires value`);
  return {
    op: 'set',
    fieldId: raw.fieldId,
    ...(bindings && { bindings }),
    value: structuredClone(raw.value),
  };
}

function parseBindings(
  raw: unknown,
  changeIndex: number,
): Readonly<Record<string, string | number>> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw invalidRequest(`Config change ${changeIndex} bindings must be an object`);
  const entries = Object.entries(raw);
  if (entries.some(([, value]) => typeof value !== 'string' && typeof value !== 'number')) {
    throw invalidRequest(`Config change ${changeIndex} bindings must contain only strings or numbers`);
  }
  return Object.fromEntries(entries) as Record<string, string | number>;
}

function resolvePath(
  field: ConfigFieldDescriptor,
  supplied: Readonly<Record<string, string | number>> | undefined,
  changeIndex: number,
  domain: string,
): string {
  const bindings = supplied ?? {};
  const expectedNames = field.bindings.map((binding) => binding.name).sort();
  const actualNames = Object.keys(bindings).sort();
  const missing = expectedNames.filter((name) => !Object.hasOwn(bindings, name));
  const unexpected = actualNames.filter((name) => !expectedNames.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new ConfigFieldChangeError(
      'CONFIG_FIELD_BINDINGS_INVALID',
      `Bindings do not match config field ${field.fieldId}`,
      {
        domain,
        fieldId: field.fieldId,
        pathTemplate: field.pathTemplate,
        missing,
        unexpected,
        changeIndex,
      },
    );
  }

  const definitions = new Map(field.bindings.map((binding) => [binding.name, binding]));
  return field.pathTemplate
    .split('/')
    .map((token) => {
      const name = placeholderName(token);
      if (!name) return token;
      const definition = definitions.get(name)!;
      const value = bindings[name];
      validateBinding(definition, value, field, changeIndex, domain);
      return definition.kind === 'record-key'
        ? escapePointerToken(value as string)
        : String(value);
    })
    .join('/');
}

function validateBinding(
  binding: ConfigFieldBindingDescriptor,
  value: string | number | undefined,
  field: ConfigFieldDescriptor,
  changeIndex: number,
  domain: string,
): void {
  const valid = binding.kind === 'record-key'
    ? typeof value === 'string'
    : typeof value === 'number' && Number.isInteger(value) && value >= 0;
  if (valid) return;
  throw new ConfigFieldChangeError(
    'CONFIG_FIELD_BINDINGS_INVALID',
    `Binding ${binding.name} is invalid for config field ${field.fieldId}`,
    {
      domain,
      fieldId: field.fieldId,
      binding: binding.name,
      bindingKind: binding.kind,
      value,
      changeIndex,
    },
  );
}

function finalBinding(field: ConfigFieldDescriptor): ConfigFieldBindingDescriptor | undefined {
  const finalToken = field.pathTemplate.split('/').at(-1);
  const name = placeholderName(finalToken);
  return name ? field.bindings.find((binding) => binding.name === name) : undefined;
}

function placeholderName(token: string | undefined): string | undefined {
  const match = token && /^\{([A-Za-z][A-Za-z0-9_]*)\}$/.exec(token);
  return match?.[1];
}

function escapePointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function assertKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw invalidRequest(`${label} contains unknown fields: ${unexpected.sort().join(', ')}`);
  }
}

function invalidRequest(message: string): ConfigFieldChangeError {
  return new ConfigFieldChangeError('CONFIG_CHANGE_INVALID', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
