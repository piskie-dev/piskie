import { createCompactId } from '@shared/utils/identifiers.js';

export interface TaskDefinitionIdAllocator {
  allocate(isOccupied: (candidate: string) => boolean | Promise<boolean>): Promise<string>;
}

export class CompactTaskDefinitionIdAllocator implements TaskDefinitionIdAllocator {
  private readonly reserved = new Set<string>();

  constructor(
    private readonly createCandidate: () => string = createCompactId,
    private readonly maxAttempts = 100,
  ) {}

  async allocate(
    isOccupied: (candidate: string) => boolean | Promise<boolean>,
  ): Promise<string> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const candidate = `td-${this.createCandidate()}`;
      if (this.reserved.has(candidate) || await isOccupied(candidate)) continue;
      this.reserved.add(candidate);
      return candidate;
    }
    throw new Error('Unable to allocate a unique Task Definition ID');
  }
}

export const taskDefinitionIdAllocator = new CompactTaskDefinitionIdAllocator();
