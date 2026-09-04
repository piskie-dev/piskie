/**
 * 目录（双玻璃设置台 · 左玻璃）。
 *
 * 分组眉标(推理/网络/应用)+ 分类项;AI/生图两类挂手风琴供应商子列表
 * (当前使用绿点/模型数/全局参数/添加供应商),目录直达供应商。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  BadgeInfo,
  Bot,
  Chrome,
  Image as ImageIcon,
  Palette,
  Plus,
  ScrollText,
  Settings,
  ShieldHalf,
  UserRound,
} from 'lucide-react';

import type { GatewayKind } from './data/vendor-atlas';
import styles from './deck.module.css';

export interface CatalogProviderItem {
  readonly id: string;
  readonly title: string;
  readonly brand: string;
  readonly modelCount: number;
  readonly active: boolean;
}

export type DeckSect =
  | 'ai' | 'image' | 'ai-tuning' | 'image-tuning'
  | 'proxy' | 'account' | 'look' | 'kernel' | 'logs' | 'about';

export interface CatalogPaneProps {
  readonly sect: DeckSect;
  readonly providers: Record<GatewayKind, readonly CatalogProviderItem[]>;
  readonly picked: Record<GatewayKind, string | null>;
  readonly onSect: (sect: DeckSect) => void;
  readonly onProvider: (gateway: GatewayKind, providerId: string) => void;
  readonly onAddProvider: (gateway: GatewayKind) => void;
}

const GATEWAY_META: Record<GatewayKind, { labelKey: string; tuning: DeckSect; icon: React.ReactNode }> = {
  ai: { labelKey: 'settings.catalog.aiProviders', tuning: 'ai-tuning', icon: <Bot size={15} /> },
  image: { labelKey: 'settings.catalog.imageProviders', tuning: 'image-tuning', icon: <ImageIcon size={15} /> },
};

export const CatalogPane: React.FC<CatalogPaneProps> = ({
  sect,
  providers,
  picked,
  onSect,
  onProvider,
  onAddProvider,
}) => {
  const { t } = useTranslation();

  const gatewayBranch = (gateway: GatewayKind): React.ReactNode => {
    const meta = GATEWAY_META[gateway];
    const family = sect === gateway || sect === meta.tuning;
    const list = providers[gateway];
    return (
      <React.Fragment key={gateway}>
        <button
          type="button"
          className={styles.leaf}
          data-on={family}
          onClick={() => onSect(gateway)}
        >
          {meta.icon}
          {t(meta.labelKey)}
          <span className={styles.leafCount}>{list.length}</span>
        </button>
        <div className={styles.twigList} data-sub={gateway} data-open={family}>
          {list.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.twig}
              data-on={sect === gateway && picked[gateway] === item.id}
              onClick={() => onProvider(gateway, item.id)}
            >
              {item.active && <span className={styles.twigDot} />}
              <span className={styles.twigLabel}>{item.title}</span>
              <span className={styles.twigCount}>{item.modelCount}</span>
            </button>
          ))}
          <button
            type="button"
            className={styles.twig}
            data-on={sect === meta.tuning}
            onClick={() => onSect(meta.tuning)}
          >
            <Settings size={12} aria-hidden="true" />
            <span className={styles.twigLabel}>{t('settings.catalog.globalDefaults')}</span>
          </button>
          <button
            type="button"
            className={styles.twig}
            onClick={() => onAddProvider(gateway)}
          >
            <Plus size={12} aria-hidden="true" />
            <span className={styles.twigLabel}>{t('settings.catalog.addProvider')}</span>
          </button>
        </div>
      </React.Fragment>
    );
  };

  const plainLeaf = (
    target: DeckSect,
    icon: React.ReactNode,
    label: string,
  ): React.ReactNode => (
    <button type="button" className={styles.leaf} data-on={sect === target} onClick={() => onSect(target)}>
      {icon}
      {label}
    </button>
  );

  return (
    <aside className={`${styles.pane} ${styles.catalog}`} aria-label={t('settings.catalog.ariaLabel')}>
      <div className={styles.crown}>{t('settings.title')}</div>
      <div className={styles.catalogScroll}>
        <div className={styles.branch}>{t('settings.catalog.inferenceGroup')}</div>
        {gatewayBranch('ai')}
        {gatewayBranch('image')}
        <div className={styles.branch}>{t('settings.catalog.networkGroup')}</div>
        {plainLeaf('proxy', <ShieldHalf size={15} />, t('settings.catalog.proxy'))}
        <div className={styles.branch}>{t('settings.catalog.applicationGroup')}</div>
        {plainLeaf('account', <UserRound size={15} />, t('settings.catalog.account'))}
        {plainLeaf('look', <Palette size={15} />, t('settings.catalog.appearance'))}
        {plainLeaf('kernel', <Chrome size={15} />, t('settings.catalog.browserRuntime'))}
        {plainLeaf('logs', <ScrollText size={15} />, t('settings.tabs.logs'))}
        {plainLeaf('about', <BadgeInfo size={15} />, t('settings.tabs.about'))}
      </div>
    </aside>
  );
};
