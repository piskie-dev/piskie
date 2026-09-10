import type { WorkerDefinition } from '../worker-definition.js';
import { WORKSPACE_TOOL_NAMES } from '../native-tool-sets.js';
import { BROWSER_EXECUTION, WORKER_INSTRUCTIONS } from '../../prompts/identities/worker.js';

export const browserWorkerDefinition: WorkerDefinition = {
  name: 'browser-worker',
  description: '在 Piskie 启动的真实浏览器窗口里操作网页，用户能看到过程；也能处理本地文件和命令。一个 Worker 负责一个网站或一段连续业务上下文',
  instructions: [WORKER_INSTRUCTIONS, BROWSER_EXECUTION].join('\n\n'),
  assignment: 'task-board',
  tools: ['web_search', ...WORKSPACE_TOOL_NAMES, 'task', 'send_event', 'generate_image', 'load_skill', 'skill_call']
    .map((name) => ({ name })),
  resources: { browser: {}, image: true },
};
