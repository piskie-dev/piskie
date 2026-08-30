/**
 * 外观与语言页（重写,自旧「系统设置」拆分）。
 *
 * 主题深浅二选(「跟随系统」已退役:存量 auto 值首次进入本页时按当前生效主题
 * 落定为显式深/浅)、界面语言(即存即换)、背景图片(选图与壁纸同一次淡化;
 * 恢复默认不阻塞清理)、遮罩滑杆(APP_BG_MASK_MIN/MAX 实时)。
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image as ImageIcon, Moon, Sun } from 'lucide-react';
import { DEFAULT_SETTINGS } from '@shared/constants';

import {
  APP_BG_MASK_MAX,
  APP_BG_MASK_MIN,
  estimateImageIsLight,
  fadeAppBackground,
} from '../../../components/shared/appBackgroundFade';
import { Toggle } from '../../../components/task-definition/controls';
import { messageText, type PresentationText } from '../../../i18n/presentationText';
import { useUIStore } from '../../../store';
import { DeckSelect } from '../bits/DeckSelect';
import styles from '../deck.module.css';

export const LookDesk: React.FC<{
  readonly onFlash: (text: PresentationText, tone?: 'halt' | 'hold' | 'calm') => void;
}> = ({ onFlash }) => {
  const { t } = useTranslation();
  const updateSettings = useUIStore((s) => s.updateSettings);
  const settings = useUIStore((s) => s.settings);
  const currentTheme = useUIStore((s) => s.theme);
  const backgroundImage = useUIStore((s) => s.backgroundImage);
  const backgroundMaskOpacity = useUIStore((s) => s.backgroundMaskOpacity);
  const setBackgroundMaskOpacity = useUIStore((s) => s.setBackgroundMaskOpacity);
  const setBackgroundIsLight = useUIStore((s) => s.setBackgroundIsLight);
  const navEdgeDockEnabled = useUIStore((s) => s.navEdgeDockEnabled);
  const navPrismEnabled = useUIStore((s) => s.navPrismEnabled);

  const [picking, setPicking] = useState(false);

  /* 「跟随系统」退役:存量 auto 按当前生效主题一次性落定为显式值 */
  useEffect(() => {
    if (currentTheme !== 'auto') return;
    const effective = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    void updateSettings({ theme: effective });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 双轨导航至少保留一个入口；本地先提示，ConfigHost 同样校验。 */
  const flipNavScheme = (scheme: 'edgeDock' | 'prism', on: boolean): void => {
    const nextEdgeDock = scheme === 'edgeDock' ? on : navEdgeDockEnabled;
    const nextPrism = scheme === 'prism' ? on : navPrismEnabled;
    if (!nextEdgeDock && !nextPrism) {
      onFlash(messageText('settings.appearance.navigationRequired'), 'hold');
      return;
    }
    void updateSettings(scheme === 'edgeDock'
      ? { navEdgeDockEnabled: on }
      : { navPrismEnabled: on });
  };

  const pickBackground = async (): Promise<void> => {
    setPicking(true);
    try {
      const background = await window.piskie.desktop.theme.pickBackground();
      if (!background) return; // 取消选图
      // 明暗判定仍记录(存量 auto 在别处解析时消费),但不再翻转主题
      const isLight = await estimateImageIsLight(background);
      const {
        backgroundImage: previousBackground,
        backgroundIsLight: previousIsLight,
        backgroundMaskOpacity: mask,
      } = useUIStore.getState();
      await fadeAppBackground(background, mask);
      if (!await updateSettings({ backgroundImage: background })) {
        await fadeAppBackground(previousBackground, mask);
        setBackgroundIsLight(previousIsLight);
        return;
      }
      setBackgroundIsLight(isLight);
      onFlash(messageText('settings.appearance.backgroundUpdated'));
    } finally {
      setPicking(false);
    }
  };

  const clearBackground = async (): Promise<void> => {
    const {
      backgroundImage: previousBackground,
      backgroundMaskOpacity: mask,
    } = useUIStore.getState();
    await fadeAppBackground(null, mask);
    if (!await updateSettings({ backgroundImage: null })) {
      await fadeAppBackground(previousBackground, mask);
      return;
    }
    setBackgroundIsLight(null);
    // 文件清理不阻塞 UI
    void window.piskie.desktop.theme.clearBackground();
    onFlash(messageText('settings.appearance.backgroundReset'));
  };

  const commitBackgroundMask = (opacity: number): void => {
    void updateSettings({ backgroundMaskOpacity: opacity }).then((updated) => {
      if (updated) return;
      const persisted = useUIStore.getState().settings?.backgroundMaskOpacity;
      if (persisted !== undefined) setBackgroundMaskOpacity(persisted);
    });
  };

  return (
    <>
      <div className={styles.deskHead}>
        <span className={styles.deskIdent}>
          <div className={styles.deskTitle}><span>{t('settings.appearance.pageTitle')}</span></div>
          <div className={styles.deskSub}>{t('settings.appearance.pageSubtitle')}</div>
        </span>
      </div>

      <div className={styles.deskBody}>
        <div className={styles.slab}>
          <div className={styles.slabCap}>{t('settings.appearance.navigationSection')}</div>

          <div className={styles.rowLine}>
            <span className={styles.rowMain}>
              <span className={styles.rowName}><span>{t('settings.appearance.edgeNavigation')}</span></span>
              <span className={styles.rowNote}>{t('settings.appearance.edgeNavigationHint')}</span>
            </span>
            <Toggle
              on={navEdgeDockEnabled}
              ariaLabel={t('settings.appearance.edgeNavigation')}
              onFlip={(on) => flipNavScheme('edgeDock', on)}
            />
          </div>

          <div className={styles.rowLine}>
            <span className={styles.rowMain}>
              <span className={styles.rowName}><span>{t('settings.appearance.floatingNavigation')}</span></span>
              <span className={styles.rowNote}>{t('settings.appearance.floatingNavigationHint')}</span>
            </span>
            <Toggle
              on={navPrismEnabled}
              ariaLabel={t('settings.appearance.floatingNavigation')}
              onFlip={(on) => flipNavScheme('prism', on)}
            />
          </div>
        </div>

        <div className={styles.slab}>
          <div className={styles.slabCap}>{t('settings.appearance.displaySection')}</div>

          <div className={styles.rowLine}>
            <span className={styles.rowMain}>
              <span className={styles.rowName}><span>{t('settings.appearance.themeMode')}</span></span>
              <span className={styles.rowNote}>{t('settings.appearance.themeHint')}</span>
            </span>
            <span className={styles.lever}>
              <button
                type="button"
                data-on={currentTheme === 'dark'}
                onClick={() => void updateSettings({ theme: 'dark' })}
              >
                <Moon size={13} />
                {t('settings.appearance.darkTheme')}
              </button>
              <button
                type="button"
                data-on={currentTheme === 'light'}
                onClick={() => void updateSettings({ theme: 'light' })}
              >
                <Sun size={13} />
                {t('settings.appearance.lightTheme')}
              </button>
            </span>
          </div>

          <div className={styles.rowLine}>
            <span className={styles.rowMain}>
              <span className={styles.rowName}><span>{t('settings.appearance.interfaceLanguage')}</span></span>
              <span className={styles.rowNote}>{t('settings.appearance.languageHint')}</span>
            </span>
            <span style={{ inlineSize: 150 }}>
              <DeckSelect
                ariaLabel={t('settings.appearance.interfaceLanguage')}
                options={[
                  { value: 'zh-CN', label: t('settings.appearance.simplifiedChinese') },
                  { value: 'en-US', label: t('settings.appearance.english') },
                ]}
                value={settings?.language ?? DEFAULT_SETTINGS.language}
                onPick={(language) => void updateSettings({ language: language as 'zh-CN' | 'en-US' })}
              />
            </span>
          </div>

          <div className={styles.rowLine}>
            {backgroundImage ? (
              <span className={styles.wallThumb} style={{ backgroundImage: `url("${backgroundImage}")` }} />
            ) : (
              <span className={styles.brandBox}><ImageIcon size={15} /></span>
            )}
            <span className={styles.rowMain}>
              <span className={styles.rowName}><span>{t('settings.appearance.backgroundImage')}</span></span>
              <span className={styles.rowNote}>{t('settings.appearance.backgroundImageDesc')}</span>
            </span>
            {backgroundImage && (
              <button type="button" className={styles.btn} onClick={() => void clearBackground()}>
                {t('settings.appearance.backgroundClear')}
              </button>
            )}
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrime}`}
              disabled={picking}
              onClick={() => void pickBackground()}
            >
              {picking ? t('settings.appearance.backgroundPicking') : t('settings.appearance.backgroundPick')}
            </button>
          </div>

          {backgroundImage && (
            <div className={styles.rowLine}>
              <span className={styles.rowMain}>
                <span className={styles.rowName}><span>{t('settings.appearance.backgroundMask')}</span></span>
                <span className={styles.rowNote}>{t('settings.appearance.backgroundMaskDesc')}</span>
              </span>
              <span className={`${styles.monoNote} ${styles.rowNote}`}>
                {Math.round(backgroundMaskOpacity * 100)}%
              </span>
              <input
                type="range"
                className={styles.rangeIn}
                min={APP_BG_MASK_MIN}
                max={APP_BG_MASK_MAX}
                step={0.01}
                value={backgroundMaskOpacity}
                aria-label={t('settings.appearance.backgroundMask')}
                onChange={(event) => setBackgroundMaskOpacity(Number(event.target.value))}
                onPointerUp={(event) => {
                  commitBackgroundMask(Number(event.currentTarget.value));
                }}
                onKeyUp={(event) => {
                  commitBackgroundMask(Number(event.currentTarget.value));
                }}
                onBlur={(event) => {
                  commitBackgroundMask(Number(event.currentTarget.value));
                }}
              />
            </div>
          )}
        </div>

      </div>
    </>
  );
};
