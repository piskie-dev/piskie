/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Snapshot creation keeps Piskie's globally stale UID contract and omits
 * DevTools-selected nodes, third-party handles, and upstream response types.
 */

import type { ElementHandle, Page, SerializedAXNode } from 'puppeteer-core';

let nextSnapshotId = 1;

export interface TextSnapshotNode extends Omit<SerializedAXNode, 'children'> {
  readonly id: string;
  readonly children: TextSnapshotNode[];
}

export interface TextSnapshotResult {
  readonly snapshotId: string;
  readonly root: TextSnapshotNode;
  readonly idToNode: ReadonlyMap<string, TextSnapshotNode>;
  readonly verbose: boolean;
}

export async function createTextSnapshot(
  page: Page,
  verbose = false
): Promise<TextSnapshotResult> {
  const root = await page.accessibility.snapshot({
    includeIframes: true,
    interestingOnly: !verbose,
  });
  if (!root) throw new Error('Failed to create accessibility snapshot');

  const snapshotId = String(nextSnapshotId++);
  let nodeIndex = 0;
  const idToNode = new Map<string, TextSnapshotNode>();

  const assignIds = (node: SerializedAXNode): TextSnapshotNode => {
    const result: TextSnapshotNode = {
      ...node,
      ...(node.role === 'option' && node.name ? { value: String(node.name) } : {}),
      id: `${snapshotId}_${nodeIndex++}`,
      children: node.children?.map(assignIds) ?? [],
    };
    idToNode.set(result.id, result);
    return result;
  };

  return {
    snapshotId,
    root: assignIds(root),
    idToNode,
    verbose,
  };
}

export async function resolveSnapshotElement(
  snapshot: TextSnapshotResult,
  uid: string
): Promise<ElementHandle<Element>> {
  const [snapshotId] = uid.split('_');
  if (snapshot.snapshotId !== snapshotId) {
    throw new Error(
      'This uid is coming from a stale snapshot. Call take_snapshot to get a fresh snapshot.'
    );
  }
  const node = snapshot.idToNode.get(uid);
  if (!node) throw new Error('No such element found in the snapshot');

  try {
    const handle = await node.elementHandle();
    if (!handle) throw new Error('No such element found in the snapshot');
    return handle as ElementHandle<Element>;
  } catch (error) {
    if (error instanceof Error && error.message === 'No such element found in the snapshot') {
      throw error;
    }
    throw new Error('No such element found in the snapshot', { cause: error });
  }
}

export function formatTextSnapshot(snapshot: TextSnapshotResult): string {
  return formatNode(snapshot.root);
}

export function resetSnapshotIdsForTesting(): void {
  nextSnapshotId = 1;
}

function formatNode(node: TextSnapshotNode, depth = 0): string {
  const indent = '  '.repeat(depth);
  let output = `${indent}[${node.id}] ${node.role ?? ''}`;
  if (node.name) output += ` "${node.name}"`;
  if (node.value !== undefined && node.value !== '') output += ` = "${String(node.value)}"`;
  output += '\n';
  for (const child of node.children) output += formatNode(child, depth + 1);
  return output;
}
