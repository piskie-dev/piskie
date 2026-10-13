/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.10.1 TextSnapshot, McpPage UID resolution,
 * and SnapshotFormatter, using the host's per-page identity owner.
 */

import type { ElementHandle, Page, SerializedAXNode } from 'puppeteer-core';
import { getDevToolsData } from './devtools-reader.js';

let nextSnapshotId = 1;

/** Puppeteer exposes these AX identity fields at runtime, but omits them from SerializedAXNode. */
export interface TextSnapshotNode extends Omit<SerializedAXNode, 'children'> {
  readonly id: string;
  readonly backendNodeId?: number;
  readonly loaderId?: string;
  readonly children: TextSnapshotNode[];
}

export interface TextSnapshotResult {
  readonly snapshotId: string;
  readonly root: TextSnapshotNode;
  readonly idToNode: ReadonlyMap<string, TextSnapshotNode>;
  readonly verbose: boolean;
  readonly hasSelectedElement?: boolean;
  readonly selectedElementUid?: string;
}

export interface TextSnapshotOptions {
  readonly identityMap?: Map<string, string>;
  readonly devtoolsData?: { readonly cdpBackendNodeId?: number };
}

type IdentityAXNode = SerializedAXNode & { backendNodeId?: number; loaderId?: string };

export async function createTextSnapshot(
  page: Page,
  verbose = false,
  options: TextSnapshotOptions = {},
): Promise<TextSnapshotResult> {
  const root = await page.accessibility.snapshot({
    includeIframes: true,
    interestingOnly: !verbose,
  });
  if (!root) throw new Error('Failed to create accessibility snapshot');

  const identityMap = options.identityMap ?? new Map<string, string>();
  const snapshotId = String(nextSnapshotId++);
  let idCounter = 0;
  const idToNode = new Map<string, TextSnapshotNode>();
  const seenUniqueIds = new Set<string>();

  const assignIds = (node: IdentityAXNode): TextSnapshotNode => {
    const uniqueBackendId = `${node.loaderId}_${node.backendNodeId}`;
    let id = identityMap.get(uniqueBackendId);
    if (id === undefined) {
      id = `${snapshotId}_${idCounter++}`;
      identityMap.set(uniqueBackendId, id);
    }
    seenUniqueIds.add(uniqueBackendId);
    const result: TextSnapshotNode = {
      ...node,
      ...(node.role === 'option' && node.name ? { value: String(node.name) } : {}),
      id,
      children: node.children?.map(assignIds) ?? [],
    };
    idToNode.set(id, result);
    return result;
  };

  const rootWithIds = assignIds(root);
  const devtoolsData = options.devtoolsData ?? await getDevToolsData(page);
  const selectedId = devtoolsData.cdpBackendNodeId;
  let selectedElementUid: string | undefined;
  if (selectedId) {
    const pending = [rootWithIds];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.backendNodeId === selectedId) { selectedElementUid = node.id; break; }
      pending.push(...node.children);
    }
  }
  for (const key of identityMap.keys()) {
    if (!seenUniqueIds.has(key)) identityMap.delete(key);
  }
  return {
    snapshotId,
    root: rootWithIds,
    idToNode,
    verbose,
    hasSelectedElement: Boolean(selectedId),
    selectedElementUid,
  };
}

export async function resolveSnapshotElement(
  snapshot: TextSnapshotResult,
  uid: string,
  pageId?: number,
): Promise<ElementHandle<Element>> {
  const node = snapshot.idToNode.get(uid);
  if (!node) throw new Error(`Element uid "${uid}" not found on page ${pageId ?? '?'}.`);
  const message = `Element with uid ${uid} no longer exists on the page.`;
  try {
    const handle = await node.elementHandle();
    if (!handle) throw new Error(message);
    return handle as ElementHandle<Element>;
  } catch (error) {
    throw new Error(message, { cause: error });
  }
}

export function formatTextSnapshot(snapshot: TextSnapshotResult): string {
  const note = !snapshot.verbose && snapshot.hasSelectedElement && !snapshot.selectedElementUid
    ? 'Note: there is a selected element in the DevTools Elements panel but it is not included into the current a11y tree snapshot.\nGet a verbose snapshot to include all elements if you are interested in the selected element.\n\n'
    : '';
  return note + formatNode(snapshot.root, snapshot.selectedElementUid);
}

export function resetSnapshotIdsForTesting(): void { nextSnapshotId = 1; }

const booleanPropertyMap: Record<string, string> = {
  disabled: 'disableable', expanded: 'expandable', focused: 'focusable', selected: 'selectable',
};
const excludedAttributes = new Set(['id', 'role', 'name', 'elementHandle', 'children', 'backendNodeId', 'loaderId']);

function formatNode(node: TextSnapshotNode, selectedElementUid?: string, depth = 0): string {
  const attributes = [`uid=${node.id}`];
  if (node.role) attributes.push(node.role === 'none' ? 'ignored' : node.role);
  if (node.name) attributes.push(`"${node.name}"`);
  for (const attr of Object.keys(node).sort()) {
    if (excludedAttributes.has(attr)) continue;
    const value = (node as unknown as Record<string, unknown>)[attr];
    if (typeof value === 'boolean') {
      const mapped = booleanPropertyMap[attr];
      if (mapped) attributes.push(mapped);
      if (value) attributes.push(attr);
    } else if (typeof value === 'string' || typeof value === 'number') {
      attributes.push(`${attr}="${value}"`);
    }
  }
  let output = `${'  '.repeat(depth)}${attributes.join(' ')}${node.id === selectedElementUid ? ' [selected in the DevTools Elements panel]' : ''}\n`;
  for (const child of node.children) output += formatNode(child, selectedElementUid, depth + 1);
  return output;
}
