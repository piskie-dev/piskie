export class CappedPage {
  readonly text: string;
  readonly count: number;
  readonly truncated: boolean;

  constructor(options: { text: string; count: number; truncated: boolean }) {
    this.text = options.text;
    this.count = options.count;
    this.truncated = options.truncated;
    Object.freeze(this);
  }
}

export async function collectCapped<T>(
  source: AsyncIterable<T>,
  options: {
    limit: number;
    render(item: T): string;
    more(shown: number): string;
    empty: string;
  },
): Promise<CappedPage> {
  const lines: string[] = [];
  let truncated = false;

  for await (const item of source) {
    if (lines.length >= options.limit) {
      truncated = true;
      break;
    }
    lines.push(options.render(item));
  }

  const body = lines.length > 0 ? lines.join('\n') : options.empty;
  return new CappedPage({
    text: truncated ? `${body}\n\n${options.more(lines.length)}` : body,
    count: lines.length,
    truncated,
  });
}
