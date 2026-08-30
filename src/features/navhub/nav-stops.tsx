/**
 * 双轨导航共用的目的地事实表。
 *
 * 隐形左坞与自由棱镜共用同一份目的地:路径 / 标题 key / 图标。
 * 文案经 t() 解析后由 Layout 注入组件;此处只放静态事实。
 */

import type { FC, SVGProps } from 'react';
import {
  Chrome,
  MessageSquareText,
  MessagesSquare,
  Puzzle,
  SlidersHorizontal,
} from 'lucide-react';

export interface NavStopSpec {
  readonly path: string;
  /** i18n key */
  readonly titleKey: string;
  readonly Icon: FC<SVGProps<SVGSVGElement>>;
}

export const NAV_STOPS: readonly NavStopSpec[] = [
  { path: '/console', titleKey: 'nav.sessionHub', Icon: MessageSquareText },
  { path: '/market', titleKey: 'nav.market', Icon: Puzzle },
  { path: '/browser', titleKey: 'nav.environmentGallery', Icon: Chrome },
  { path: '/messaging', titleKey: 'nav.messagingDock', Icon: MessagesSquare },
  { path: '/preferences', titleKey: 'nav.preferenceDeck', Icon: SlidersHorizontal },
];

/** 运行时目的地(标题已解析,运行灯已求值) */
export interface NavStop {
  readonly path: string;
  readonly title: string;
  readonly Icon: FC<SVGProps<SVGSVGElement>>;
  /** 该入口是否点亮运行呼吸灯(目前只有会话) */
  readonly live: boolean;
}
