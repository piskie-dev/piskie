import { useState } from 'react';
import { PencilLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../console/chrome/Dialog';
import styles from './agent-management.module.css';

interface Props {
  type: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

export function WorkerDisplayNameEditor({ type, value, disabled, onChange }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  return (
    <>
      <button
        type="button"
        className={styles.iconButton}
        disabled={disabled}
        aria-label={t('agentManagement.editRemark')}
        title={t('agentManagement.editRemark')}
        onClick={() => {
          setName(value);
          setOpen(true);
        }}
      >
        <PencilLine size={14} />
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('agentManagement.remarkName')}
        width={440}
      >
        <form
          className={styles.remarkForm}
          onSubmit={(event) => {
            event.preventDefault();
            onChange(name.trim());
            setOpen(false);
          }}
        >
          <code className={styles.remarkType}>{type}</code>
          <label className={styles.remarkField}>
            {t('agentManagement.remarkName')}
            <input
              autoFocus
              value={name}
              maxLength={80}
              placeholder={type}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <p className={styles.note}>{t('agentManagement.remarkHint')}</p>
          <p className={styles.note}>{t('agentManagement.remarkSaveHint')}</p>
          <div className={styles.remarkActions}>
            <button
              type="button"
              className={styles.textButton}
              disabled={!name}
              onClick={() => setName('')}
            >
              {t('agentManagement.remarkClear')}
            </button>
            <div className={styles.actions}>
              <button type="button" className={styles.button} onClick={() => setOpen(false)}>
                {t('common.cancel')}
              </button>
              <button type="submit" className={`${styles.button} ${styles.primary}`}>
                {t('agentManagement.remarkConfirm')}
              </button>
            </div>
          </div>
        </form>
      </Dialog>
    </>
  );
}
