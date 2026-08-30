import { appLog } from '@electron/observability/logging/app-log.js';
/**
 * 占用登记表
 *
 * 全部状态是一张 key → Occupancy 的表。没有计时器、没有冻结态、没有强制模式，
 * 也不反查「持有者还活着吗」——判活是调用方的知识（AgentService 手上才有
 * activeRuntimes 与 failedTeardowns），登记表不为了回答这个问题去持有一个回调。
 *
 * 释放只有一个入口：releaseAllOwnedBy(agentId)。顶层 teardown 与 persisted-only stop
 * 用的是同一个谓词（占用者是它、或归属于它），因此不需要第二种释放形状。
 */

import type { ClaimRequest, ClaimResult, Occupancy } from '../../../shared/types/occupancy.js';
import { occupancyKey } from '../../../shared/types/occupancy.js';
import { createChangeChannel, type ChangeSource, type Unsubscribe } from '../change-channel.js';

export class OccupancyRegistry {
  private readonly byKey = new Map<string, Occupancy>();
  private readonly changeChannel = createChangeChannel<Occupancy[]>({
    onSubscriberError: (error) =>
      appLog.error({
        event: 'resource.occupancy.publish.failed',
        message: 'Resource occupancy publication failed',
        context: { scope: 'resource.occupancy' },
        error,
      }),
  });

  readonly changes: ChangeSource<Occupancy[]> = this.changeChannel.source;

  subscribe(
    listener: (occupancies: Occupancy[]) => void,
    options?: { signal?: AbortSignal }
  ): Unsubscribe {
    return this.changes.subscribe(listener, options);
  }

  /**
   * 声明占用。同一 key 已被他人占用即失败并交出当前占用者——冲突文案各处不同
   * （浏览器环境与浏览器实例的处置建议不同），登记表不替调用方措辞。
   * 同一占用者重复声明视为刷新。
   */
  claim(req: ClaimRequest): ClaimResult {
    const key = occupancyKey(req.kind, req.resourceId);
    const held = this.byKey.get(key);
    if (held && held.occupantId !== req.occupantId) {
      return { ok: false, heldBy: held };
    }

    const occupancy: Occupancy = Object.freeze({
      key,
      kind: req.kind,
      resourceId: req.resourceId,
      occupantId: req.occupantId,
      ownerId: req.ownerId,
      occupantName: req.occupantName,
      since: new Date().toISOString(),
    });
    this.byKey.set(key, occupancy);

    this.notify();
    return { ok: true, occupancy };
  }

  /**
   * 释放 agentId 直接占用的、以及归属于它（其子代理）的全部占用，返回释放条数。
   *
   * 唯一的释放形状。调用方须自行确认该 agent 确实该被释放——teardown 凭据齐全，
   * 或 persisted-only 且未被隔离（teardown 失败的 AgentRun 保留占用即隔离）。
   */
  releaseAllOwnedBy(agentId: string): number {
    let released = 0;
    for (const [key, occupancy] of this.byKey) {
      if (occupancy.occupantId !== agentId && occupancy.ownerId !== agentId) continue;
      this.byKey.delete(key);
      released++;
    }
    if (released > 0) {
      this.notify();
    }
    return released;
  }

  find(key: string): Occupancy | undefined {
    return this.byKey.get(key);
  }

  list(): Occupancy[] {
    return Object.freeze([...this.byKey.values()]) as unknown as Occupancy[];
  }

  /** 清空全表：启动时抹掉上一轮进程的残留，退出时按清理权顺序交还引用。 */
  clear(): void {
    if (this.byKey.size === 0) return;
    this.byKey.clear();
    this.notify();
  }

  private notify(): void {
    this.changeChannel.sink.publish(this.list());
  }
}

export const occupancyRegistry = new OccupancyRegistry();
