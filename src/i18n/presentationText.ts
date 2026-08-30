export type PresentationValue = string | number | PresentationText;

export type PresentationText =
  | Readonly<{ kind: 'raw'; text: string }>
  | Readonly<{
      kind: 'message';
      key: string;
      values?: Readonly<Record<string, PresentationValue>>;
    }>;

export type PresentationTranslator = (
  key: string,
  values?: Readonly<Record<string, string | number>>,
) => string;

export class PresentationError extends Error {
  constructor(readonly presentation: PresentationText) {
    super(presentation.kind === 'raw' ? presentation.text : presentation.key);
    this.name = 'PresentationError';
  }
}

export function rawText(text: string): PresentationText {
  return { kind: 'raw', text };
}

export function messageText(
  key: string,
  values?: Readonly<Record<string, PresentationValue>>,
): PresentationText {
  return values ? { kind: 'message', key, values } : { kind: 'message', key };
}

export function resolvePresentationText(
  value: PresentationText,
  translate: PresentationTranslator,
): string {
  if (value.kind === 'raw') return value.text;
  if (!value.values) return translate(value.key);

  const resolved = Object.fromEntries(
    Object.entries(value.values).map(([key, item]) => [
      key,
      typeof item === 'object' ? resolvePresentationText(item, translate) : item,
    ]),
  );
  return translate(value.key, resolved);
}

export function isPresentationText(value: unknown): value is PresentationText {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { kind?: unknown; text?: unknown; key?: unknown };
  return candidate.kind === 'raw'
    ? typeof candidate.text === 'string'
    : candidate.kind === 'message' && typeof candidate.key === 'string';
}

export function presentationFromError(
  error: unknown,
  fallback: PresentationText,
): PresentationText {
  if (error instanceof PresentationError) return error.presentation;
  if (error instanceof Error) return rawText(error.message);
  if (typeof error === 'string') return rawText(error);
  return fallback;
}
