export function formatRequestTokenCheckpoint(
  inputTokens: number,
  inputTokenDelta?: number,
  locale = 'en-US',
): string {
  if (inputTokenDelta === undefined) {
    return `${new Intl.NumberFormat(locale).format(inputTokens)} tokens`;
  }
  return `${new Intl.NumberFormat(locale, { signDisplay: 'exceptZero' }).format(inputTokenDelta)} tokens`;
}
