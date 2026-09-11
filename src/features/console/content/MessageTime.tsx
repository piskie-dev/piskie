import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { relativeMessageTime } from '../data/messageTime';
import styles from './threads.module.css';

export const MessageTime = memo<{ timestamp?: number }>(({ timestamp }) => {
  const { t, i18n } = useTranslation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (timestamp === undefined) return;
    let timer: number;
    const update = () => {
      const current = Date.now();
      setNow(current);
      timer = window.setTimeout(update, relativeMessageTime(timestamp, current).nextUpdateIn);
    };
    const visible = () => { window.clearTimeout(timer); update(); };
    update();
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [timestamp]);
  if (timestamp === undefined) return <span className={styles.rowTime} />;
  const date = new Date(timestamp);
  const { unit, count } = relativeMessageTime(timestamp, now);
  const fullDate = date.toLocaleString(i18n.language, { dateStyle: 'full', timeStyle: 'medium' });
  return (
    <time
      className={styles.rowTime}
      dateTime={date.toISOString()}
      title={t('sessionWorkbenchUi.sidebar.latestMessage', { date: fullDate })}
    >
      {t(`sessionWorkbenchUi.sidebar.messageTime.${unit}`, { count })}
    </time>
  );
});

MessageTime.displayName = 'MessageTime';
