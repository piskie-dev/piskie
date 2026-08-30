import type { InferenceDriver } from './contracts.js';

export class DriverRegistry {
  private readonly drivers = new Map<string, InferenceDriver>();

  register(driver: InferenceDriver): void {
    const id = driver.manifest.id;
    if (this.drivers.has(id)) throw new Error(`Inference driver already registered: ${id}`);
    this.drivers.set(id, driver);
  }

  get(id: string): InferenceDriver | undefined {
    return this.drivers.get(id);
  }

  list(): readonly InferenceDriver[] {
    return [...this.drivers.values()].sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  }
}

