import path from 'node:path';
import type { AtomicFileWriter } from '../../config/core/atomic-file-writer.js';
import { configDomainStoragePaths } from '../../config/core/storage-layout.js';
import { VersionedFileConfigRepository } from '../../config/core/versioned-file-repository.js';
import { inferenceConfigSchema, type InferenceConfig } from './config-schema.js';

export interface InferenceConfigPaths {
  rootDirectory: string;
  configFile: string;
  selectionFile: string;
  selectionLockFile: string;
  historyDirectory: string;
  plansDirectory: string;
  workflowDirectory: string;
  runtimeReceiptFile: string;
  artifactDirectory: string;
  imageJobDirectory: string;
  lockFile: string;
}

export function inferenceConfigPaths(rootDirectory: string): InferenceConfigPaths {
  const root = path.resolve(rootDirectory);
  const storage = configDomainStoragePaths(root, 'inference');
  const selectionStorage = configDomainStoragePaths(root, 'inference-selections');
  return {
    rootDirectory: root,
    configFile: storage.configFile,
    selectionFile: selectionStorage.configFile,
    selectionLockFile: selectionStorage.lockFile,
    historyDirectory: storage.historyDirectory,
    plansDirectory: storage.plansDirectory,
    workflowDirectory: path.join(root, 'workflows', 'comfyui'),
    runtimeReceiptFile: path.join(root, 'runtime', 'inference.json'),
    artifactDirectory: path.join(root, 'runtime', 'image-artifacts'),
    imageJobDirectory: path.join(root, 'runtime', 'image-jobs'),
    lockFile: storage.lockFile,
  };
}

interface ConfigRepositoryOptions {
  writer?: AtomicFileWriter;
  onHistoryMaintenanceError?: (error: unknown) => void;
}

export class InferenceConfigRepository {
  private readonly repository: VersionedFileConfigRepository<InferenceConfig>;

  constructor(
    readonly paths: InferenceConfigPaths,
    options: ConfigRepositoryOptions = {},
  ) {
    this.repository = new VersionedFileConfigRepository({
      domain: 'inference',
      paths,
      codec: {
        parse: (raw) => inferenceConfigSchema.parse(raw),
      },
      writer: options.writer,
      onHistoryMaintenanceError: options.onHistoryMaintenanceError,
    });
  }

  exists(): Promise<boolean> {
    return this.repository.exists();
  }

  initialize(config: InferenceConfig): Promise<void> {
    return this.repository.initialize(config);
  }

  read(): Promise<InferenceConfig> {
    return this.repository.read();
  }

  readRevision(revision: number): Promise<InferenceConfig> {
    return this.repository.readRevision(revision);
  }

  history(): Promise<readonly number[]> {
    return this.repository.history();
  }

  pruneHistory(): Promise<readonly number[]> {
    return this.repository.pruneHistory();
  }

  commit(candidate: InferenceConfig, expectedRevision: number): Promise<InferenceConfig> {
    return this.repository.commit(candidate, expectedRevision);
  }
}

export { ConfigRepositoryError } from '../../config/contracts/repository.js';
export type { ConfigRepositoryErrorCode } from '../../config/contracts/repository.js';
