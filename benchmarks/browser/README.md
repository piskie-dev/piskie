# 浏览器操作基准

这是一套独立、可重复运行的复杂业务页面，以及基于实际页面结果的基准报告工具。用于观察浏览器操作、模型决策和任务完成情况；每次尝试都有新建的业务状态，使用固定 seed 复现数据。

代码放在 `benchmarks/browser/`，与应用页面、生产浏览器实现和单元测试夹具分开。不随桌面应用打包，也不使用仓库中被忽略的 `docs/`、`reports/` 或设计预览目录存放源码。依赖现有 Node 24 和 `puppeteer-core`，无需安装新包。

## 目录

```text
benchmarks/browser/
  cli.mjs                  命令入口
  fixture/
    scenarios.mjs          版本、场景、业务任务和能力矩阵
    server.mjs             回环 HTTP 服务、每次运行的状态和独立结果判定
    smoke.mjs              通过真实浏览器 UI 执行业务的脚本
    data/                  永久、虚构的上传附件
    web/                   业务测试站点
  runner/
    environment.mjs        Git revision、工作区差异指纹和执行环境
    piskie.mjs             现有应用的真实模型运行与实时指标采集
    core.ts                当前源码浏览器工具的场景执行与调用计时
  vitest.config.ts         独立的源码工具测试配置
  reporting/               数据合同、聚合和离线报告
  tests/                   服务、结果判定、指标与采集器的测试
```

截图、浏览器 profile、原始运行记录和生成的报告默认写入新的系统临时目录。也可用 `--output-dir` 显式指定独立产物目录。不要把这些运行产物提交进测试源码目录。

## 八个独立场景

| ID | 任务 | 主要压力点 |
| --- | --- | --- |
| `intake` | 创建服务申请并核对回执 | 密集表单、批量填表、文本/日期/下拉/单选/复选、校验、延迟提交 |
| `inventory` | 筛选、翻页、刷新后预留指定 SKU | 长列表、重复按钮、DOM 替换、稳定 UID、动态等待、正确实体 |
| `approvals` | 读取悬停提示，取消一次确认，再完成审批 | hover 菜单、原生 confirm/prompt/alert、取消及副作用 |
| `board` | 打包指定包裹、上传附件、发运 | 拖放、文件选择、附件内容校验、工作流前置条件 |
| `frames` | 修改嵌套组件中的路由并重载核对 | 双层 iframe、open shadow、表单、组件重挂载 |
| `tabs` | 新窗口签收，关闭并回原页对账 | popup、多页选择、跨页状态、返回与刷新 |
| `diagnostics` | 定位失败请求、取消扫描、修复配置并提交证据 | 真实 HTTP 失败、console、请求详情、取消、重试 |
| `journey` | 从申请到库存、发运和签收的综合订单 | 多阶段导航、跨页操作、相互依赖的真实业务结果 |

`journey` 使用自己的新订单，独立执行所有阶段；其结果不抵扣七个单项场景。任务给出业务目标和必要数据，不限制底层操作次数。所有联系人、订单、SKU 和附件都是虚构数据，全部网络请求留在本地服务。

## 使用

在仓库根目录运行：

```bash
npm run bench:browser -- list
npm run bench:browser -- serve --port 4175
```

打开服务打印的 URL，在场景入口创建一个新任务。每次创建都会得到独立 `runId` 和任务 URL；使用相同 seed 可以复现业务数据。服务默认只监听 `127.0.0.1`，无需启动或重启桌面应用。

先验证页面及其业务流程：

```bash
npm run bench:browser:test
npm run bench:browser -- smoke \
  --chromium /path/to/chrome \
  --scenario intake,inventory,approvals,board,frames,tabs,diagnostics,journey \
  --seed 1 --repeats 1 \
  --output-dir /tmp/browser-smoke
```

也可以通过 `FP_CHROMIUM_PATH` 提供 Chromium 路径，添加 `--headed` 查看独立浏览器窗口。脚本通过 UI 完成任务，再从服务端读取结果；它只证明页面流程与结果判定可以工作，不提供模型 token、tok/s 或模型工具步数。

直接检验当前工作区的浏览器优化，无需构建或重启应用：

```bash
FP_CHROMIUM_PATH=/path/to/chrome \
PISKIE_TEST_ARTIFACT_DIR=/tmp/browser-source \
TMPDIR=/tmp \
npm run bench:browser:core
```

这个入口使用当前 TypeScript 源码的 BrowserManager、session 和公开浏览器工具，在八个新场景中真实执行快照、批量填表、拖放、上传、页面切换和观测。仅替代 Electron 窗口布局和持久连接查询，浏览器操作保持真实。运行会打印独立产物目录，保存报告、每次工具调用及耗时 `tools.jsonl`、截图和清理结果；失败场景会使测试退出码非零。未设置 `FP_CHROMIUM_PATH` 时八项明确跳过，不代表通过。

UI smoke 和源码工具测试都属于 `scripted`，通过 `environment.runner` 区分，不能互作性能基线。源码工具测试可以报告实际工具调用次数与耗时；没有模型参与，token、模型轮数与 tok/s 仍为 N/A。任务计时在业务操作及结果检查后结束，截图、报告写盘和浏览器清理不计入任务耗时。

指纹浏览器不暴露 console 事件时，可给 `smoke` / `run` 添加 `--allow-missing-console`，或给源码工具测试设置 `PISKIE_BENCH_ALLOW_MISSING_CONSOLE=1`。这只放行缺失的 console 观测；网络证据、业务字段和最终结果仍必须通过。报告保留 `console observation unavailable` 说明，且会区分必需/可选 console 策略，避免把已放行的覆盖缺口当成实测成功。

真实模型测试需要一个已经运行、暴露本地 renderer 调试端口的 Piskie 应用，以及已经配置的模型：

```bash
npm run bench:browser -- run \
  --model demo-provider::demo-model \
  --cdp-url http://127.0.0.1:9223 \
  --scenario intake,inventory \
  --seed 1 --repeats 3 --timeout-ms 180000 \
  --variant candidate --runtime-label candidate-build \
  --output-dir /tmp/browser-candidate
```

`run` 会实际调用模型并产生正常的应用任务记录。它通过现有公开 API 新建测试任务，不更改持久模型配置。`--model` 指定协调任务的模型；浏览器任务会遵循应用已有的 Worker 模型偏好，报告记录父任务和浏览器任务**实际观察到的模型**。运行前应自行保持模型配置、reasoning、浏览器设置和机器负载一致。任务使用临时浏览器；不要在测量期间干预该测试任务。

基准命令不会构建或重启开发环境。当前工作区 revision/diffHash 只能证明采集时的源码状态，不能证明已运行应用加载了同一份代码。`--runtime-label` 是运行者提供的构建标记，不是自动校验。若修改需要重启才能进入模型测试，按项目开发环境规则显式启动对应构建后再采集。

如无法读取任务浏览器的版本或 viewport，报告保留未知值；Electron 控制台窗口的版本和尺寸不能代替任务浏览器。缺失关键环境信息的记录不支持严格的环境配对比较。

## 报告和比较

`smoke` 与 `run` 自动写出：

- `records/`：每次尝试的原始 JSON，包括独立结果检查和采集覆盖情况。
- `report.json`：原始记录、汇总和比较数据。
- `report.md`：可审阅的文字报告。
- `report.html`：可离线打开的可视化报告，无外部资源。

重建报告或比较两组记录：

```bash
npm run bench:browser -- report \
  --input /tmp/browser-candidate \
  --baseline /tmp/browser-baseline \
  --output-dir /tmp/browser-comparison
```

`--input` 和 `--baseline` 可重复使用，接受单条 JSON、JSONL、`report.json` 或运行目录；重复 `runId` 会报错，避免重复计数。

比较前固定 suite 版本、scenario、seed、执行模式、真实模型组合、viewport 和其他环境条件。脚本运行还记录 Chromium 可执行文件的 SHA256，以区分版本字符串相同的不同内核。每场景重复多次并交替运行 baseline/candidate 可以降低暖机和负载波动影响。不同模型分别展示；不同模型、缺失场景、未知环境和覆盖不足不会被合并成一个“优化百分比”。失败与超时保留在分母中，单次结果不构成统计显著性结论。

## 测量口径

| 指标 | 含义 |
| --- | --- |
| 实际结果 | 服务端检查业务提交、字段、关键副作用及关联记录；不是模型自报、tool ok 或 Worker completed |
| 成功率 | 实际检查通过且正常完成的尝试数 / 所有尝试数；失败、取消、超时保留 |
| 墙钟耗时 | 从启动该尝试到结束/超时的单调时钟时长，包含协调、模型、工具和等待 |
| 工具步数 | Runtime 已结算工具调用，包含失败和非浏览器工具；不是 click/fill 原子动作数 |
| 模型轮数 | Runtime 成功结算的逻辑模型请求数 |
| tok/s | 同一实际模型的配对输出 token 总和 / 对应最终成功 attempt 的完整秒数，含 TTFT；不是纯 decode 速度 |
| TTFT | 可用首 token 等待时长总和 / 对应样本数 |
| LLM 时长 | 成功逻辑请求的累计耗时，可能包含重试和 backoff |
| 工具时长 | 单 Agent 内合并重叠执行区间；跨 Agent 的合计不等于任务墙钟 |
| token 用量 | Runtime 成功请求结算的 Provider usage；缺失显示 N/A，零与未知分开，不包含失败 attempt 的计费用量 |
| 采集覆盖 | 实时观察是否完整，指标本身是否 complete/partial/none；换模累计指标不归入单一模型 |

实时指标随 Runtime 生命周期累积，历史预览会置零。因此采集器在启动前订阅变化，并保存新建任务的实时状态；不能在事后用历史状态补出工具步数。部分覆盖的样本保留原始值和说明，不据此声称全任务吞吐。

## 扩展

新增场景时，在 `fixture/scenarios.mjs` 注册任务和能力，补充业务页面、服务端状态变更与独立检查，并让 UI smoke 和源码工具执行器完成真实流程。改变任务难度、数据、判定或计时口径时更新 suite 版本，防止新旧结果误配。

新增采集器时输出 `reporting/` 的同一数据合同；不需要修改业务页面或报告格式。生产浏览器代码的回归测试仍保留在其原有 `electron/.../__tests__/` 目录中，这套基准负责可复用的复杂任务和运行比较。
