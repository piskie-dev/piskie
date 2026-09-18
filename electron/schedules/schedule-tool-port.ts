import type { SchedulePort } from '../tools/types.js';

/**
 * 工具侧端口的晚绑定壳：Agent 运行时在推理组件就位时就拿到它，
 * 真正的实现（能力层 ScheduleApplication）在后端启动完成后才绑定。
 */
export interface LateBoundSchedulePort extends SchedulePort {
  bind(port: SchedulePort): void;
  unbind(): void;
}

export function createLateBoundSchedulePort(): LateBoundSchedulePort {
  let target: SchedulePort | undefined;
  const resolve = (): SchedulePort => {
    if (!target) throw new Error('Schedule service is not available');
    return target;
  };
  return {
    bind: (port) => {
      target = port;
    },
    unbind: () => {
      target = undefined;
    },
    create: (input, createdBy) => resolve().create(input, createdBy),
    list: () => resolve().list(),
    cancel: (scheduleId) => resolve().cancel(scheduleId),
  };
}
