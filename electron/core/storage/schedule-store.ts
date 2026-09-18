import type { Schedule } from '../../../shared/types/schedules.js';
import { createChangeChannel, type ChangeSource } from '../change-channel.js';

/** Config Domain `schedules` 发布到的内存快照；调度器与能力层只从这里读定义。 */
export class ScheduleStore {
  private schedules: Schedule[] = [];
  private readonly channel = createChangeChannel<readonly Schedule[]>();
  readonly changes: ChangeSource<readonly Schedule[]> = this.channel.source;

  list(): Schedule[] {
    return structuredClone(this.schedules);
  }

  get(scheduleId: string): Schedule | null {
    return this.list().find((schedule) => schedule.scheduleId === scheduleId) ?? null;
  }

  publish(schedules: readonly Schedule[]): void {
    this.schedules = structuredClone([...schedules]);
    this.channel.sink.publish(this.list());
  }
}

export const scheduleStore = new ScheduleStore();
