import {
  XMarkdown,
  type ComponentProps,
  type Tokens,
  type XMarkdownProps,
} from '@ant-design/x-markdown';
import {
  useMemo,
  type ComponentType,
  type ReactNode,
} from 'react';

import { ContentLink, LinkedText } from './ContentLinks';
import { MarkdownImage, MarkdownImageProvider, type MarkdownImageOptions } from './MarkdownImage';
import {
  scanContentTargets,
  targetFromLinkHref,
  type ContentTargetKind,
} from './scanTargets';
import { markdownSourceBlocks, SOURCE_BLOCK_TAG } from './markdownSourceBlocks';
import { MermaidBlock } from './MermaidBlock';

const TARGET_TAG = 'piskie-content-target';
const MERMAID_TAG = 'piskie-mermaid';
let explicitLinkDepth = 0;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return character;
    }
  });
}

function renderDetectedTargets(text: string): string {
  const targets = scanContentTargets(text);
  if (targets.length === 0) return escapeHtml(text);

  const output: string[] = [];
  let cursor = 0;
  for (const target of targets) {
    if (target.start > cursor) output.push(escapeHtml(text.slice(cursor, target.start)));
    output.push(
      `<${TARGET_TAG} data-kind="${target.kind}" data-target="${encodeURIComponent(target.value)}">`
      + `${escapeHtml(target.value)}</${TARGET_TAG}>`,
    );
    cursor = target.end;
  }
  if (cursor < text.length) output.push(escapeHtml(text.slice(cursor)));
  return output.join('');
}

const linkedMarkdownConfig: NonNullable<XMarkdownProps['config']> = {
  renderer: {
    image(token) {
      const titleAttribute = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      // Preserve local destinations through HTML sanitization; MarkdownImage resolves the actual src.
      return `<img data-image-src="${escapeHtml(token.href)}" alt="${escapeHtml(token.text)}"${titleAttribute}>`;
    },
    link(token) {
      explicitLinkDepth += 1;
      try {
        const label = this.parser.parseInline(token.tokens);
        const titleAttribute = token.title ? ` title="${escapeHtml(token.title)}"` : '';
        return `<a href="${escapeHtml(token.href)}"${titleAttribute}>${label}</a>`;
      } finally {
        explicitLinkDepth -= 1;
      }
    },
    text(token) {
      if ('tokens' in token && token.tokens) return this.parser.parseInline(token.tokens);
      if ('escaped' in token && token.escaped) return token.text;
      return explicitLinkDepth > 0 ? escapeHtml(token.text) : renderDetectedTargets(token.text);
    },
  },
};

/** Marked removes one terminal newline from fenced text; retain it for source copying. */
function mermaidCode(token: Tokens.Code): { source: string; closed: boolean } {
  const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(token.raw);
  const fence = opening?.[1];
  if (!opening || !fence) return { source: token.text, closed: false };
  const body = token.raw.slice(opening[0].length);
  const closing = new RegExp(`(?:^|\\n) {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\n)?$`).exec(body);
  const inner = closing ? body.slice(0, closing.index + (closing[0].startsWith('\n') ? 1 : 0)) : body;
  return { source: token.text + (inner.endsWith('\n') ? '\n' : ''), closed: !!closing };
}

function MarkdownMermaid(props: ComponentProps) {
  return <MermaidBlock source={childrenToText(props.children) ?? ''} complete={props['data-complete'] === 'true'} />;
}

type TargetComponentProps = ComponentProps & {
  'data-kind'?: string;
  'data-target'?: string;
};

function decodeTarget(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function MarkdownDetectedTarget(props: ComponentProps) {
  const targetProps = props as TargetComponentProps;
  const kind = targetProps['data-kind'];
  const target = decodeTarget(targetProps['data-target']);
  if ((kind !== 'url' && kind !== 'path') || !target) return <>{props.children}</>;
  return (
    <ContentLink kind={kind as ContentTargetKind} target={target}>
      {props.children}
    </ContentLink>
  );
}

function MarkdownAnchor(props: ComponentProps) {
  const href = (props as ComponentProps & { href?: string }).href ?? '';
  const target = targetFromLinkHref(href);
  if (!target) return <>{props.children}</>;
  return (
    <ContentLink kind={target.kind} target={target.value}>
      {props.children ?? href}
    </ContentLink>
  );
}

function childrenToText(children: ReactNode): string | null {
  if (typeof children === 'string') return children;
  if (Array.isArray(children) && children.every((child) => typeof child === 'string')) {
    return children.join('');
  }
  return null;
}

function MarkdownCode(props: ComponentProps) {
  const text = childrenToText(props.children);
  if (text === null) return <code className={props.className}>{props.children}</code>;
  return (
    <code className={props.className}>
      <LinkedText>{text}</LinkedText>
    </code>
  );
}

const linkedMarkdownComponents: NonNullable<XMarkdownProps['components']> = {
  a: MarkdownAnchor,
  img: MarkdownImage,
  code: MarkdownCode,
  [TARGET_TAG]: MarkdownDetectedTarget,
  [MERMAID_TAG]: MarkdownMermaid,
};

export interface SourceBlockProps {
  readonly startLine: number;
  readonly endLine: number;
  readonly children: ReactNode;
}

export type LinkedMarkdownProps = Omit<XMarkdownProps, 'components' | 'config'> & MarkdownImageOptions & {
  readonly sourceBlocks?: {
    readonly startLine: number;
    readonly component: ComponentType<SourceBlockProps>;
  };
};

/** XMarkdown with full-text URL/path detection and the shared activation behavior. */
export function LinkedMarkdown({
  escapeRawHtml = true, sourceBlocks, baseDirectory, onPreviewImage, ...props
}: LinkedMarkdownProps) {
  const imageOptions = useMemo(() => ({ baseDirectory, onPreviewImage }), [baseDirectory, onPreviewImage]);
  const startLine = sourceBlocks?.startLine;
  const SourceBlock = sourceBlocks?.component;
  const hasNextChunk = props.streaming?.hasNextChunk === true;
  const config = useMemo<NonNullable<XMarkdownProps['config']>>(() => ({
    ...linkedMarkdownConfig,
    ...(startLine === undefined ? {} : markdownSourceBlocks(startLine)),
    renderer: {
      ...linkedMarkdownConfig.renderer,
      code(token) {
        if (token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() !== 'mermaid') return false;
        const { source, closed } = mermaidCode(token);
        // Dispatch the whole block so XMarkdown's ordinary pre/code styles stay on code only.
        return `<${MERMAID_TAG} data-complete="${!hasNextChunk || closed}">`
          + escapeHtml(source) + `</${MERMAID_TAG}>\n`;
      },
    },
  }), [hasNextChunk, startLine]);
  const components = useMemo(() => !SourceBlock ? linkedMarkdownComponents : {
    ...linkedMarkdownComponents,
    [SOURCE_BLOCK_TAG]: function MarkdownSourceBlock(props: ComponentProps) {
      return (
        <SourceBlock startLine={Number(props['data-source-start'])} endLine={Number(props['data-source-end'])}>
          {props.children}
        </SourceBlock>
      );
    },
  }, [SourceBlock]);
  return (
    <MarkdownImageProvider options={imageOptions}>
      <XMarkdown
        {...props}
        escapeRawHtml={escapeRawHtml}
        components={components}
        config={config}
      />
    </MarkdownImageProvider>
  );
}
