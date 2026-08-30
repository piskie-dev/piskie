import { bootstrapInferenceConfig } from '../../inference/control/bootstrap-config.js';
import type { InferenceControlPlane } from '../../inference/control/control-plane.js';
import type { InferenceSelectionStore } from '../../inference/control/selection-store.js';
import { createConfigHost as composeConfigHost } from '../../config/host/composition.js';
import type { ConfigHost } from '../../config/host/config-host.js';
import { connectLocalConfigHost } from '../../config/host/local-transport.js';
import {
  CliArgumentError,
  CONFIG_COMMAND_DEFINITIONS,
  createDefaultControlPlane,
  createDefaultDriverRegistry,
  createDefaultSelectionStore,
  type ConfigCliDependencies,
  type ConfigCliIo,
  type ParsedArguments,
  shouldConnectRunningConfigHost,
} from '../../inference/config-cli/main.js';

/** config 命令组挂载点：按 action 索引 inference 域导出的命令定义表 */
export const CONFIG_COMMANDS = new Map(
  CONFIG_COMMAND_DEFINITIONS.map((definition) => [definition.action, definition]),
);

export interface ExecuteConfigCommandInput {
  action?: string;
  subject?: string;
  parsed: ParsedArguments;
  io: ConfigCliIo;
  rootDirectory: string;
  dependencies: Partial<ConfigCliDependencies>;
  /** 命令定位且状态就绪后、执行前回调：信封 command 字段在此刻定名 */
  onExecute?(): void;
}

export async function executeConfigCommand(input: ExecuteConfigCommandInput): Promise<unknown> {
  const { action, subject, parsed, io, rootDirectory, dependencies } = input;
  const definition = action ? CONFIG_COMMANDS.get(action) : undefined;
  if (!definition) {
    throw new CliArgumentError(`Unknown config command: ${action ?? ''}`.trim());
  }
  if (definition.requiresState && shouldConnectRunningConfigHost(dependencies)) {
    input.onExecute?.();
    const host = await (dependencies.connectConfigHost ?? connectLocalConfigHost)(rootDirectory);
    return definition.execute({ host, io, parsed, subject });
  }
  if (!dependencies.createControlPlane && definition.requiresState) {
    await bootstrapInferenceConfig({
      rootDirectory,
      drivers: createDefaultDriverRegistry(rootDirectory),
    });
  }
  const control = (dependencies.createControlPlane ?? createDefaultControlPlane)(rootDirectory);
  const selections = (dependencies.createSelectionStore ?? createDefaultSelectionStore)(rootDirectory);
  const host = (dependencies.createConfigHost
    ?? ((
      inference: InferenceControlPlane,
      root: string = rootDirectory,
      selectionStore: InferenceSelectionStore = selections,
    ): ConfigHost => composeConfigHost({
      rootDirectory: root,
      inference,
      selections: selectionStore,
    })))(control, rootDirectory, selections);
  if (definition.requiresState) await host.prepare();
  input.onExecute?.();
  return definition.execute({ host, io, parsed, subject });
}
