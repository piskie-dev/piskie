import type { PersistedMessageBlock, PersistedToolResultBlock } from '../../../../../shared/types';
import { imagePaths } from '../../../../../shared/tool-images';

/** Renderer media accepted by console Cells; Base64 is deliberately not a member. */
export type CellMedia =
  | Readonly<{ kind: 'file'; path: string }>
  | Readonly<{ kind: 'preview-url'; url: string }>;

type PersistedImageCarrier = PersistedMessageBlock | PersistedToolResultBlock;

/** Project canonical image refs in block order; retired inline images are not a UI input. */
export function extractCellMedia(
  blocks: readonly PersistedImageCarrier[] | string,
): readonly CellMedia[] | undefined {
  if (!Array.isArray(blocks)) return undefined;
  const images = imagePaths(blocks)
    .map<CellMedia>((path) => ({
      kind: 'file',
      path,
    }));
  return images.length > 0 ? images : undefined;
}
