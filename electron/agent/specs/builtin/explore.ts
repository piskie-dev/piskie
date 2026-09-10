import type { WorkerDefinition } from '../worker-definition.js';
import { EXPLORE_INSTRUCTIONS } from '../../prompts/identities/explore.js';

export const exploreDefinition: WorkerDefinition = {
  name: 'explore',
  description: '只读检索型 Worker：需要扫多个文件、目录或命名约定才能回答，且只要结论不要文件内容时使用。它读片段不读全文，负责定位代码和事实，不评审、不给方案。prompt 写明检索广度：定位（找到即止）或全面（覆盖所有相关位置）',
  instructions: EXPLORE_INSTRUCTIONS,
  assignment: 'question',
  tools: [
    ...['read', 'glob', 'grep', 'ls'].map((name) => ({ name })),
    { name: 'send_event', options: { events: ['completed', 'failed', 'user_stopped'] } },
  ],
  includeSkillDocs: false,
  allowedParentSpecs: ['director', 'system-chat'],
  mcpServers: [],
};
