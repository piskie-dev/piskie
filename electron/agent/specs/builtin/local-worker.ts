import type { WorkerDefinition } from '../worker-definition.js';
import { WORKSPACE_TOOL_NAMES } from '../native-tool-sets.js';
import { WORKER_INSTRUCTIONS } from '../../prompts/identities/worker.js';

export const localWorkerDefinition: WorkerDefinition = {
  name: 'local-worker',
  description: '在本地读写文件、执行命令，完成多任务工作包',
  instructions: WORKER_INSTRUCTIONS,
  assignment: 'task-board',
  tools: ['web_search', ...WORKSPACE_TOOL_NAMES, 'task', 'send_event', 'generate_image', 'load_skill', 'skill_call']
    .map((name) => ({ name })),
  resources: { image: true },
};
