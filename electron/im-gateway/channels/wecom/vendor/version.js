import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 从 package.json 中读取版本号，兼容打包产物和直接运行 .ts 两种场景 */
const getVersion = () => {
    try {
        // ESM 环境使用 import.meta.url，CJS 环境使用全局 __dirname
        const currentDir = dirname(fileURLToPath(import.meta.url));
        // 直接运行 .ts 时在 src/ 下，打包后在 dist/ 下，都向上一级找 package.json
        const pkgPath = resolve(currentDir, "..", "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        return pkg.version ?? "";
    }
    catch {
        return "";
    }
};
/** 插件版本号，来源于 package.json */
const PLUGIN_VERSION = getVersion();

export { PLUGIN_VERSION };
