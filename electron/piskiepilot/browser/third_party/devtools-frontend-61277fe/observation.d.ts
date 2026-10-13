// Copyright 2026 Piskie Team. Local types for the fixed observation-only bundle.
import type { CDPSession, Issue } from 'puppeteer-core';
import type { ConsoleDevToolsModel } from '../../core/session/console-stack.js';

export interface FrontendIssueDetails extends Record<string, unknown> {
  violatingNodeId?: number;
  nodeId?: number;
  documentNodeId?: number;
  request?: { url?: string; requestId?: string };
}
export interface FrontendIssue {
  code(): string;
  primaryKey(): string;
  details(): FrontendIssueDetails | null;
}
export interface MarkdownIssueDescription {
  file: string;
  links: Array<{ link: string; linkTitle: string }>;
  substitutions?: Map<string, string>;
}
export class AggregatedIssue {
  getAggregatedIssuesCount(): number;
  getDescription(): MarkdownIssueDescription | null;
  getAllIssues(): Iterable<FrontendIssue>;
  code(): string;
}
export class IssueProvider {
  issues(): FrontendIssue[];
  dispatchEventToListeners(event: symbol, data: { issue: FrontendIssue; issuesModel: null }): void;
}
export class IssueAggregator {
  constructor(provider: IssueProvider);
  addEventListener(event: symbol, listener: (event: { data: AggregatedIssue }) => void): void;
  removeEventListener(event: symbol, listener: (event: { data: AggregatedIssue }) => void): void;
}
export const IssueAggregatorEvents: { AGGREGATED_ISSUE_UPDATED: symbol };
export const IssuesManagerEvents: { ISSUE_ADDED: symbol };
export function initializeConsoleFrontend(loadResource: (url: string) => Promise<string>): void;
export function createConsoleModel(session: CDPSession, loadResource: (url: string) => Promise<string>): ConsoleDevToolsModel;
export function createIssuesFromProtocolIssue(model: null, issue: Issue): readonly FrontendIssue[];
export function isIssueCodeSupported(code: string): boolean;
export function substitutePlaceholders(markdown: string, substitutions?: Map<string, string>): string;
export function issueTitle(markdown: string): string | null;
