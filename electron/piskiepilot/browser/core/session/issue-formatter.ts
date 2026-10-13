/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.10.1 src/formatters/IssueFormatter.ts and
 * src/devtools/issueDescriptions.ts. Uses the pinned frontend issue resources.
 */

import { readFileSync } from 'node:fs';
import { AggregatedIssue, issueTitle, substitutePlaceholders } from '../../third_party/devtools-frontend-61277fe/observation.js';

export interface IssueFormatterOptions {
  readonly id: number;
  readonly requestIdResolver?: (requestId: string) => number | undefined;
  readonly elementIdResolver?: (backendNodeId: number) => string | undefined;
}
export interface AffectedResource {
  readonly uid?: string;
  readonly data?: unknown;
  readonly request?: string | number;
}
export interface IssueConcise {
  readonly type: 'issue';
  readonly title?: string;
  readonly count: number;
  readonly id: number;
}
export interface IssueDetailed extends IssueConcise {
  readonly description?: string;
  readonly links?: readonly { readonly link: string; readonly linkTitle: string }[];
  readonly affectedResources: readonly AffectedResource[];
}
const descriptions = new Map<string, string>();

export class IssueFormatter {
  constructor(readonly issue: AggregatedIssue, readonly options: IssueFormatterOptions) {}

  #description(): string | undefined {
    const description = this.issue.getDescription();
    if (!description?.file) return undefined;
    try {
      let markdown = descriptions.get(description.file);
      if (markdown === undefined) {
        markdown = readFileSync(new URL(`../../third_party/devtools-frontend-61277fe/issue-descriptions/${description.file}`, import.meta.url), 'utf8');
        descriptions.set(description.file, markdown);
      }
      return substitutePlaceholders(markdown, description.substitutions);
    } catch { return undefined; }
  }

  #title(): string | undefined {
    const markdown = this.#description();
    if (!markdown) return undefined;
    try { return issueTitle(markdown) ?? undefined; } catch { return undefined; }
  }

  isValid(): boolean { return this.#title() !== undefined; }

  toJSON(): IssueConcise {
    return { type: 'issue', title: this.#title(), count: this.issue.getAggregatedIssuesCount(), id: this.options.id };
  }

  toJSONDetailed(): IssueDetailed {
    const affectedResources: AffectedResource[] = [];
    for (const issue of this.issue.getAllIssues()) {
      const details = issue.details();
      if (!details) continue;
      const data = structuredClone(details);
      let uid: string | undefined;
      let request: string | number | undefined;
      for (const key of ['violatingNodeId', 'nodeId', 'documentNodeId'] as const) {
        if (details[key] && this.options.elementIdResolver) {
          uid = this.options.elementIdResolver(details[key]);
          delete data[key];
        }
      }
      if (details.request) {
        request = details.request.url;
        if (details.request.requestId && this.options.requestIdResolver) {
          const id = this.options.requestIdResolver(details.request.requestId);
          if (id) { request = id; delete data.request!.requestId; }
        }
      }
      delete data.errorType;
      delete data.frameId;
      affectedResources.push({ uid, data, request });
    }
    return { ...this.toJSON(), description: this.#description(), links: this.issue.getDescription()?.links, affectedResources };
  }

  toString(): string {
    const issue = this.toJSON();
    return `msgid=${issue.id} [issue] ${issue.title ?? 'Unknown Issue'} (count: ${issue.count})`;
  }

  toStringDetailed(): string {
    const issue = this.toJSONDetailed();
    let markdown = issue.description?.trim();
    if (markdown?.startsWith('# ')) markdown = markdown.substring(2).trimStart();
    const body = [markdown || issue.title || 'Unknown Issue'];
    if (issue.links?.length) {
      body.push('Learn more:', ...issue.links.map(link => `[${link.linkTitle}](${link.link})`));
    }
    if (issue.affectedResources.length) {
      body.push('### Affected resources', ...issue.affectedResources.map(resource => [
        resource.uid ? `uid=${resource.uid}` : '',
        resource.request ? `${typeof resource.request === 'number' ? 'reqid=' : 'url='}${resource.request}` : '',
        resource.data ? `data=${JSON.stringify(resource.data)}` : '',
      ].filter(Boolean).join(' ')));
    }
    return `ID: ${issue.id}\nMessage: issue> ${body.join('\n')}`;
  }
}
