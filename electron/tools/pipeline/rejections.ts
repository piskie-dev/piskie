export const REJECT = {
  unknownTool: (name: string, available: string[]) =>
    `没有名为 ${name} 的工具。你当前可用的工具：${available.join(', ')}。`,
  relativePath: (param: string, got: string, workspace: string) =>
    `${param} 必须是绝对路径，收到 "${got}"。本 agent 的 workspace 是 ${workspace}，可直接拼接；`
    + '也可以传 workspace 之外的任何绝对路径。',
  shapeViolation: (errors: string[]) => `参数不符合 schema：\n${errors.join('\n')}`,
  neverRead: (filePath: string) =>
    `${filePath} 已存在但本轮未读过。先 read 一遍再改——避免覆盖你没看过的内容。`,
  staleRead: (filePath: string) =>
    `${filePath} 在你读过之后被改动了。重新 read 确认当前内容，然后再改。`,
  staleAtCommit: (filePath: string) =>
    `${filePath} 在你读过之后被改动了（写入前的最后一次复验发现），本次修改已终止（未写入）。`
    + '重新 read 确认内容后重新提交——原先的改动基线已不适用。',
  createdMeanwhile: (filePath: string) =>
    `${filePath} 在本次创建期间已被别人创建，未写入。先 read 看看里面是什么，再决定要不要覆盖。`,
  approvalDenied: () => '用户拒绝了这次操作。',
  executionFailed: (name: string, reason: string) => `${name} 执行失败：${reason}`,
  mustBeExclusive: (name: string) =>
    `${name} 未声明 exclusive 却试图结束本轮——这是内部错误，请报告。`,
  directOnly: (modelName: string) =>
    `${modelName} 是固定工具，请直接调用，不要经 skill_call。`,
  deferredNotLoaded: (modelName: string) =>
    `${modelName} 是 deferred MCP 工具，schema 尚未装载。`
    + `先调用 tool_search("select:${modelName}") 装载，装载后即可直接调用。`,
  unknownFunction: (skill: string, functionName: string, available: readonly string[]) =>
    `${skill} 没有 executable 函数 ${functionName}。可用函数：${available.join(', ')}。`,
  standardSkill: (skill: string) =>
    `${skill} 是标准技能，没有可直接调用的函数。`
    + `用 load_skill("${skill}") 读它的 SKILL.md，按里面的说明用 shell 执行。`,
  disabledSkill: (skill: string) =>
    `${skill} 是已安装但已禁用的 executable Skill。先启用它，再用 skill_call 调用。`,
  unknownSkill: (skill: string) =>
    `没有找到已安装的 executable 或知识型 Skill ${skill}。先用 tool_search 检索。`,
  notEligible: (
    skill: string,
    functionName: string,
    why: 'resource' | 'scope' | 'excluded' | 'notExposed',
  ) => ({
    resource: `${skill}.${functionName} 需要本 agent 没有的运行资源（如浏览器 / 设备）。`,
    scope: `${skill}.${functionName} 只对主代理开放，本 agent 是子代理。`,
    excluded: `${skill}.${functionName} 已被本 agent 的配置排除。`,
    notExposed: `${skill}.${functionName} 是固定函数，但不在本 agent 当前获得的工具面里。`,
  })[why] + '换一个能做这件事的工具，或让上级派一个有该能力的子代理。',
  rateLimited: () => '本 agent 的写入频率已达上限，稍后再试或合并成一次写入。',
} as const;
