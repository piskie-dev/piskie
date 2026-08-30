interface TopLevelErrorViewProps {
  eyebrow?: string;
  title: string;
  detail: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export function TopLevelErrorView({
  eyebrow,
  title,
  detail,
  action,
}: TopLevelErrorViewProps) {
  return (
    <main
      role="alert"
      className="flex h-screen w-screen items-center justify-center bg-cyber-bg p-8 text-cyber-text"
    >
      <section className="w-full max-w-xl rounded-card border border-cyber-error/40 bg-cyber-surface p-6 shadow-2xl">
        {eyebrow && (
          <p className="text-xs uppercase tracking-[0.24em] text-cyber-error">
            {eyebrow}
          </p>
        )}
        <h1 className={`${eyebrow ? 'mt-3 ' : ''}text-xl font-semibold`}>{title}</h1>
        <p className="mt-3 break-words text-sm text-cyber-text-muted">{detail}</p>
        {action && (
          <button
            type="button"
            className="mt-6 rounded-control bg-cyber-primary px-4 py-2 text-sm font-semibold text-white"
            onClick={action.onClick}
          >
            {action.label}
          </button>
        )}
      </section>
    </main>
  );
}
