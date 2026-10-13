import type { ElementHandle, Page, SerializedAXNode } from 'puppeteer-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTextSnapshot, formatTextSnapshot, resetSnapshotIdsForTesting, resolveSnapshotElement } from '../text-snapshot.js';

type AX = SerializedAXNode & { backendNodeId?: number; loaderId?: string; children?: AX[] };
function node(backendNodeId?: number, loaderId = 'document-a', children: AX[] = []): AX {
  return { role: 'button', name: 'Sample control', backendNodeId, loaderId, children,
    elementHandle: vi.fn(async () => ({ sample: true }) as unknown as ElementHandle<Element>) };
}
function page(root: AX) {
  return { accessibility: { snapshot: vi.fn(async () => root) } } as unknown as Page;
}
beforeEach(() => resetSnapshotIdsForTesting());

describe('fixed-source snapshot identities and serialization', () => {
  it('reuses continuous loader/backend identities and allocates only new nodes with the latest prefix', async () => {
    const current = page(node(1, 'document-a', [node(2)]));
    const identityMap = new Map<string, string>();
    const first = await createTextSnapshot(current, false, { identityMap });
    vi.mocked(current.accessibility.snapshot).mockResolvedValue(node(1, 'document-a', [node(2), node(3)]));
    const second = await createTextSnapshot(current, false, { identityMap });
    expect(second.snapshotId).toBe('2');
    expect(second.root.id).toBe('1_0');
    expect(second.root.children.map((child) => child.id)).toEqual(['1_1', '2_0']);
    await expect(resolveSnapshotElement(second, '1_1', 11)).resolves.toMatchObject({ sample: true });
    expect(first.idToNode.size).toBe(2);
  });

  it('prunes identities absent from the current traversal and reassigns them on reappearance', async () => {
    const identityMap = new Map<string, string>();
    const current = page(node(1, 'document-a', [node(2)]));
    const first = await createTextSnapshot(current, false, { identityMap });
    vi.mocked(current.accessibility.snapshot).mockResolvedValue(node(1));
    const second = await createTextSnapshot(current, true, { identityMap });
    expect(identityMap.has('document-a_2')).toBe(false);
    await expect(resolveSnapshotElement(second, first.root.children[0].id, 11)).rejects.toThrow('not found on page 11');
    vi.mocked(current.accessibility.snapshot).mockResolvedValue(node(1, 'document-a', [node(2)]));
    const third = await createTextSnapshot(current, false, { identityMap });
    expect(third.root.children[0].id).toBe('3_0');
    expect(current.accessibility.snapshot).toHaveBeenNthCalledWith(2, { includeIframes: true, interestingOnly: false });
  });

  it('isolates pages by map and distinguishes the same backend number in different documents and frames', async () => {
    const first = await createTextSnapshot(page(node(1, 'document-a', [node(1, 'frame-b')])), false, { identityMap: new Map() });
    const second = await createTextSnapshot(page(node(1)), false, { identityMap: new Map() });
    expect(first.root.id).not.toBe(first.root.children[0].id);
    expect(first.root.id).not.toBe(second.root.id);
    const map = new Map<string, string>();
    const old = await createTextSnapshot(page(node(1)), false, { identityMap: map });
    const next = await createTextSnapshot(page(node(1, 'document-b')), false, { identityMap: map });
    expect(old.root.id).not.toBe(next.root.id);
    expect([...map.keys()]).toEqual(['document-b_1']);
  });

  it('preserves the actual optional backend/empty-loader boundary of source identity concatenation', async () => {
    const identityMap = new Map<string, string>();
    const snapshot = await createTextSnapshot(page(node(undefined, '', [node(undefined, '')])), false, { identityMap });
    expect([...identityMap.keys()]).toEqual(['_undefined']);
    expect(snapshot.root.id).toBe(snapshot.root.children[0].id);
    expect(snapshot.idToNode.size).toBe(1);
  });

  it('distinguishes a missing UID from a handle that no longer exists and retains the actual cause', async () => {
    const root = node(1);
    const snapshot = await createTextSnapshot(page(root));
    await expect(resolveSnapshotElement(snapshot, 'opaque-missing-id', 22)).rejects.toThrow('Element uid "opaque-missing-id" not found on page 22.');
    vi.mocked(root.elementHandle).mockResolvedValue(null);
    await expect(resolveSnapshotElement(snapshot, snapshot.root.id, 22)).rejects.toThrow(`Element with uid ${snapshot.root.id} no longer exists on the page.`);
    const cause = new Error('Sample detached execution context');
    vi.mocked(root.elementHandle).mockRejectedValue(cause);
    await expect(resolveSnapshotElement(snapshot, snapshot.root.id, 22)).rejects.toMatchObject({ cause });
  });

  it('matches source attributes and selected-element annotation without showing backend identity', async () => {
    const root = { ...node(1), role: 'none', disabled: false, expanded: true, focused: false, selected: false,
      checked: 'mixed' as const, value: 'Sample value', children: [{ ...node(2), role: 'option', name: 'Sample option' }] };
    const snapshot = await createTextSnapshot(page(root), false, { devtoolsData: { cdpBackendNodeId: 2 } });
    expect(formatTextSnapshot(snapshot)).toBe(
      'uid=1_0 ignored "Sample control" checked="mixed" disableable expandable expanded focusable selectable value="Sample value"\n'
      + '  uid=1_1 option "Sample option" value="Sample option" [selected in the DevTools Elements panel]\n',
    );
    const filtered = await createTextSnapshot(page(node(1)), false, { devtoolsData: { cdpBackendNodeId: 2 } });
    expect(formatTextSnapshot(filtered)).toContain('Get a verbose snapshot to include all elements');
    const verbose = await createTextSnapshot(page(node(1)), true, { devtoolsData: { cdpBackendNodeId: 2 } });
    expect(formatTextSnapshot(verbose)).toBe('uid=3_0 button "Sample control"\n');
  });
});
