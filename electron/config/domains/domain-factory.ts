import type {
  ConfigDomainAdapterHooks,
  ConfigDomainContract,
} from '../contracts/domain.js';
import type { VersionedConfigDocument } from '../contracts/repository.js';
import { ManagedConfigDomain } from '../core/managed-config-domain.js';
import { configDomainStoragePaths } from '../core/storage-layout.js';
import {
  VersionedFileConfigRepository,
  type VersionedConfigCodec,
} from '../core/versioned-file-repository.js';

export interface ManagedDomainDefinition<
  TStored extends VersionedConfigDocument,
  TRead,
  TWrite,
> {
  contract: ConfigDomainContract;
  codec: VersionedConfigCodec<TStored>;
  bootstrap(): Promise<TStored> | TStored;
  adapter: ConfigDomainAdapterHooks<TStored, TRead, TWrite>;
  onHistoryMaintenanceError?: (error: unknown) => void;
}

export function createManagedDomain<
  TStored extends VersionedConfigDocument,
  TRead,
  TWrite,
>(
  rootDirectory: string,
  definition: ManagedDomainDefinition<TStored, TRead, TWrite>,
): ManagedConfigDomain<TStored, TRead, TWrite> {
  const paths = configDomainStoragePaths(rootDirectory, definition.contract.id);
  const repository = new VersionedFileConfigRepository<TStored>({
    domain: definition.contract.id,
    paths,
    codec: definition.codec,
    onHistoryMaintenanceError: definition.onHistoryMaintenanceError,
  });
  return new ManagedConfigDomain({
    contract: definition.contract,
    repository,
    adapter: definition.adapter,
    bootstrap: definition.bootstrap,
  }, paths.plansDirectory);
}
