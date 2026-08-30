import {
  XMarkdown,
  type ComponentProps,
  type XMarkdownProps,
} from '@ant-design/x-markdown';
import {
  type ReactNode,
} from 'react';

import { ContentLink, LinkedText } from './ContentLinks';
import {
  scanContentTargets,
  targetFromHref,
  type ContentTargetKind,
} from './scanTargets';

const TARGET_TAG = 'piskie-content-target';
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
  const target = targetFromHref(href);
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
  code: MarkdownCode,
  [TARGET_TAG]: MarkdownDetectedTarget,
};

export type LinkedMarkdownProps = Omit<XMarkdownProps, 'components' | 'config'>;

/** XMarkdown with full-text URL/path detection and the shared activation behavior. */
export function LinkedMarkdown({ escapeRawHtml = true, ...props }: LinkedMarkdownProps) {
  return (
    <XMarkdown
      {...props}
      escapeRawHtml={escapeRawHtml}
      components={linkedMarkdownComponents}
      config={linkedMarkdownConfig}
    />
  );
}
