/** 跨域引用查询：哪些定时任务从某个 Task Definition 启动（供 task-definitions 影响分析使用）。 */
export function schedulesBoundToDefinition(value: unknown, definitionId: string): string[] {
  if (!isRecord(value) || !isRecord(value.schedules)) return [];
  return Object.entries(value.schedules)
    .filter(([, schedule]) => {
      if (!isRecord(schedule) || !isRecord(schedule.action)) return false;
      const launch = schedule.action.launch;
      return isRecord(launch) && launch.kind === 'definition' && launch.definitionId === definitionId;
    })
    .map(([id]) => id)
    .sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
