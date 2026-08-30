import { defineSkill, type DomainDescriptor } from '../piskiepilot/core/skill/define.js';
import { z } from './params.js';
import type { ToolContext } from './types.js';

const fixture = defineSkill({
  name: 'protocol-fixture',
  domain: 'local',
  functions: {
    editText: {
      description: 'Edit text',
      params: z.object({ file_path: z.string(), text: z.string() }),
      async run(params, ctx) {
        ctx.log(params.file_path, params.text);
        return { ok: true, text: params.text };
      },
    },
    inspect: {
      description: 'Inspect',
      params: z.object({ query: z.string() }),
      async run(params) {
        return { ok: true, text: params.query };
      },
    },
  },
});
void fixture;

export const protocolDescriptor: DomainDescriptor<'local', typeof fixture.functions> = {
  domain: 'local',
  scope: 'shared',
  effects: ['write-fs'],
  policy: {
    editText: {
      mutation: { pathParam: 'file_path', priorRead: 'required' },
    },
    inspect: {
      mutation: {
        // @ts-expect-error query is the only string parameter on inspect.
        pathParam: 'file_path',
        priorRead: 'required',
      },
    },
  },
  makeContext(ctx: ToolContext) {
    return {
      signal: ctx.signal,
      taskId: ctx.agentId,
      executorId: ctx.agentId,
      log: (_message: string, _data?: unknown) => undefined,
    };
  },
};
