import type { Tokens, XMarkdownProps } from '@ant-design/x-markdown';

type MarkdownConfig = NonNullable<XMarkdownProps['config']>;

export const SOURCE_BLOCK_TAG = 'piskie-source-block';

type SourceBlockToken = Tokens.Generic & {
  startLine: number;
  endLine: number;
  tokens: NonNullable<Tokens.Generic['tokens']>;
};

/** Attach source ranges to document blocks while retaining the configured Markdown renderer. */
export function markdownSourceBlocks(startLine: number): MarkdownConfig {
  let source = '';
  let previous: { offset: number; count: number; raw: string | undefined } | undefined;
  const positions = new Map<object, { start: number; end: number }>();

  // The block tokenizer hook observes the root token list before each lexer step.
  // A step can append a token, extend the previous paragraph, or consume a link
  // definition without a visible token. Record the consumed source in each case.
  function observe(offset: number, tokens: readonly { raw: string }[]): void {
    const last = tokens.at(-1);
    if (previous && last) {
      if (tokens.length > previous.count) {
        positions.set(last, { start: previous.offset, end: offset });
      } else if (last.raw !== previous.raw) {
        positions.get(last)!.end = offset;
      }
    }
    previous = { offset, count: tokens.length, raw: last?.raw };
  }

  return {
    hooks: {
      preprocess(content) {
        source = content.replace(/\r\n?/g, '\n');
        previous = undefined;
        positions.clear();
        return source;
      },
      processAllTokens(tokens) {
        observe(source.length, tokens);
        let cursor = 0;
        let line = startLine;
        const blocks = tokens.map((token) => {
          if (token.type === 'space') return token;
          const position = positions.get(token)!;
          line += source.slice(cursor, position.start).split('\n').length - 1;
          const blockEnd = line + source.slice(position.start, position.end).trimEnd().split('\n').length - 1;
          cursor = position.start;
          return {
            type: SOURCE_BLOCK_TAG,
            raw: token.raw,
            startLine: line,
            endLine: blockEnd,
            tokens: [token],
          };
        });
        tokens.splice(0, tokens.length, ...blocks);
        return tokens;
      },
    },
    extensions: [{
      name: SOURCE_BLOCK_TAG,
      level: 'block',
      childTokens: ['tokens'],
      tokenizer(remaining, tokens) {
        if (tokens === this.lexer.tokens) observe(source.length - remaining.length, tokens);
        return undefined;
      },
      renderer(token) {
        const block = token as SourceBlockToken;
        return `<${SOURCE_BLOCK_TAG} data-source-start="${block.startLine}" data-source-end="${block.endLine}">`
          + this.parser.parse(block.tokens)
          + `</${SOURCE_BLOCK_TAG}>`;
      },
    }],
  };
}
