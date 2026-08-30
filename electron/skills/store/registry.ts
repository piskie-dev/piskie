/**
 * registry.json 管理面入口：CAS 原语与状态文件属主（执行面）共用同一实现，
 * 保证 app 内安装、CLI、插件级联三类写者走同一条锁 + 修订号协议。
 */
export {
  emptyRegistry,
  readRegistry,
  RegistryLockTimeoutError,
  RevisionConflictError,
  updateRegistry,
  type UpdateOptions,
} from '@electron/piskiepilot/core/skill/registry-store.js'
