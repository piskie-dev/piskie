import { describe, expect, it, vi } from 'vitest';
import { CompactTaskDefinitionIdAllocator } from '../task-definition-id-allocator.js';

describe('CompactTaskDefinitionIdAllocator', () => {
  it('retries an occupied candidate and returns the next td-prefixed ID', async () => {
    const candidates = ['AAAAAA', 'b8Z2Km'];
    const allocator = new CompactTaskDefinitionIdAllocator(() => candidates.shift()!, 4);
    const isOccupied = vi.fn(async (candidate: string) => candidate === 'td-AAAAAA');

    await expect(allocator.allocate(isOccupied)).resolves.toBe('td-b8Z2Km');
    expect(isOccupied).toHaveBeenCalledTimes(2);
  });

  it('fails without returning an unchecked candidate after the attempt bound', async () => {
    const allocator = new CompactTaskDefinitionIdAllocator(() => 'AAAAAA', 2);

    await expect(allocator.allocate(() => true)).rejects.toThrow(
      'unique Task Definition ID',
    );
  });
});
