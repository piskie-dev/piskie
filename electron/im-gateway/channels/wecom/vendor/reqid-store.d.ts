/** Store 配置 */
interface ReqIdStoreOptions {
    /** TTL 毫秒数，超时的 reqId 视为过期（默认 7 天） */
    ttlMs?: number;
    /** 内存最大条目数（默认 200） */
    memoryMaxSize?: number;
}
export interface PersistentReqIdStore {
    /** 设置 chatId 对应的 reqId（仅写入内存） */
    set(chatId: string, reqId: string): void;
    /** 获取 chatId 对应的 reqId（仅内存） */
    get(chatId: string): Promise<string | undefined>;
    /** 同步获取 chatId 对应的 reqId（仅内存） */
    getSync(chatId: string): string | undefined;
    /** 删除 chatId 对应的 reqId */
    delete(chatId: string): void;
    /** 清空内存缓存 */
    clearMemory(): void;
    /** 返回内存中的条目数 */
    memorySize(): number;
}
export declare function createPersistentReqIdStore(accountId: string, options?: ReqIdStoreOptions): PersistentReqIdStore;
export {};
