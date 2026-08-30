# openclaw-compat — openclaw plugin-sdk 运行时符号的本地实现

内置渠道 vendor 的协议代码（编译产物）中存在 `require("openclaw/plugin-sdk/<module>")`
运行时调用。本目录按 module 一比一提供本地实现，vendor 收编时把 require 说明符改写为
`#openclaw-compat/<module>.js`（package.json `imports` 子路径，Node 24 支持 CJS
require ESM，见 scripts/copy-im-channel-assets.mjs 与各渠道 UPSTREAM.md）。

实现拷贝/改写自 openclaw 源码（MIT License, Copyright (c) 2025 Peter Steinberger），
每个文件头部标注上游源文件。仅保留 vendor 闭包实际调用的符号——新增渠道或升级渠道
版本时，先跑 require 闭包扫描（doc 28 记录了方法），缺什么补什么。

上游仓库为 `https://github.com/openclaw/openclaw`，完整许可见同目录 `LICENSE`。

与 PISKIE 语义有意偏差的实现（非逐字拷贝）在文件内以 `PISKIE 简化` 注释标出。
