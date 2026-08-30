/**
 * EnvStudio · 导播台编排：Program 主屏 + Preview 预监列。
 * 选中态归属页面（EnvStudio）持有，本组件纯装配。
 */

import React from 'react';
import type { BrowserEnvironment } from '@shared/types';
import type { Occupancy } from '@shared/types/occupancy';
import { occupantOf } from '../data/fleet';
import { ProgramMonitor } from './ProgramMonitor';
import { PreviewRack } from './PreviewRack';
import styles from '../studio.module.css';

interface SwitchboardProps {
  envs: BrowserEnvironment[];
  occupancies: Occupancy[];
  selectedId: string | null;
  busyId: string | null;
  onSelect(envId: string): void;
  onIgnite(envId: string): void;
  onExtinguish(envId: string): void;
  onRelight(envId: string): void;
  onSurface(envId: string): void;
  onForge(env: BrowserEnvironment | null): void;
  onScrap(envId: string): void;
  /** 任一画面失联判定时核对环境状态（页面层做节流） */
  onLapse(): void;
}

export const Switchboard: React.FC<SwitchboardProps> = ({
  envs,
  occupancies,
  selectedId,
  busyId,
  onSelect,
  onIgnite,
  onExtinguish,
  onRelight,
  onSurface,
  onForge,
  onScrap,
  onLapse,
}) => {
  const program = envs.find((env) => env.id === selectedId) ?? envs[0];
  if (!program) return null;

  return (
    <div className={styles.switchboard}>
      <ProgramMonitor
        env={program}
        occupant={occupantOf(occupancies, program.id)}
        busy={busyId === program.id}
        onIgnite={() => onIgnite(program.id)}
        onExtinguish={() => onExtinguish(program.id)}
        onRelight={() => onRelight(program.id)}
        onSurface={() => onSurface(program.id)}
        onForge={() => onForge(program)}
        onScrap={() => onScrap(program.id)}
        onLapse={onLapse}
      />
      <PreviewRack
        envs={envs}
        occupancies={occupancies}
        selectedId={program.id}
        onSelect={onSelect}
        onForgeNew={() => onForge(null)}
        onLapse={onLapse}
      />
    </div>
  );
};
