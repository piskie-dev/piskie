/**
 * 占用登记
 *
 * 记录「谁正在独占哪一个物理资源」。只有物理独占才进这张表——浏览器环境目录与
 * 浏览器实例皆排他，所以没有「访问模式」这一维；也没有冻结态、
 * 宽限期、回收计时：一条记录在不在表里，就是全部状态。
 */

export type OccupancyKind = 'browserEnvironment' | 'browserInstance';

/** 占用键：同 kind 下按资源 id 唯一。渲染进程也按此键查表，故定义在 shared。 */
export function occupancyKey(kind: OccupancyKind, resourceId: string): string {
  return `${kind}:${resourceId}`;
}

export interface Occupancy {
  /** occupancyKey(kind, resourceId) */
  key: string;
  kind: OccupancyKind;
  resourceId: string;
  /** 直接占用者：顶层智能体或子代理的 id */
  occupantId: string;
  /** 归属的顶层智能体 id。occupantId === ownerId 即占用者本身就是顶层。 */
  ownerId: string;
  /** 展示名（冲突文案与前端列表用） */
  occupantName: string;
  /** ISO 时间戳（跨 IPC 序列化安全） */
  since: string;
}

export interface ClaimRequest {
  kind: OccupancyKind;
  resourceId: string;
  occupantId: string;
  ownerId: string;
  occupantName: string;
}

export type ClaimResult =
  | { ok: true; occupancy: Occupancy }
  | { ok: false; heldBy: Occupancy };
