# OpenAI Responses 重试模拟服务

用于在 Piskie 新对话中手动验收 provider 重试。需要 Node 24+；服务仅监听 `127.0.0.1`，使用内置 Node 模块，丢弃模型请求正文，不记录正文、认证头或密钥。

在项目根目录启动：

```sh
node scripts/testing/openai-responses-fault-server.mjs --port 4010 --scenario empty-response --failures 1
```

如果端口已占用，改用空闲端口，并同步替换下文 URL。前台按 `Ctrl+C` 停止；后台运行时记录 mock 的 PID，将日志写入当前任务的临时目录，用 `kill <mock-pid>` 停止。

在 Piskie 界面选择自定义 OpenAI 兼容 Provider，填写：

| 项目 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:4010/v1` |
| 协议 | **Responses** |
| 自定义模型 ID / 上游模型 ID | `mock-model` |
| 认证 | 无认证；如客户端必须填 key，可填虚构的 `mock-key`，服务不校验 |

模拟服务不读写 Piskie 的持久化 Provider 配置，也不启动或重启 Piskie。

## 场景与控制

每次 `POST /v1/responses` 都计为一次尝试；前 N 次返回所选故障，此后一直返回 `Mock retry succeeded.`，直到 reset 或重启 mock。`--failures N` 的范围为 0–100；省略 `--scenario` 时沿用 `sse-overload`。

| `scenario` | 故障响应 |
| --- | --- |
| `empty-response` | HTTP 200 SSE，以 `response.completed` 合法结束，`output: []`，无 text、reasoning 或 tool 输出 |
| `sse-stream-error` | 先输出 `Mock partial text (discard this attempt).`，再返回无 status 的 `upstream_stream_read_error` SSE 错误 |
| `sse-overload` | 无 status 的 `server_is_overloaded` SSE 错误 |
| `http-503` | HTTP 503 overload |
| `disconnect-before-output` | 输出前断开连接 |

查看状态和模型列表不会消耗失败次数：

```sh
curl -sS http://127.0.0.1:4010/__control/state
curl -sS http://127.0.0.1:4010/v1/models
```

保留当前场景和失败次数，仅把计数归零：

```sh
curl -sS -X POST http://127.0.0.1:4010/__control/reset
```

切到空响应一次后成功，或部分输出后流错误一次再成功：

```sh
curl -sS -X POST http://127.0.0.1:4010/__control/reset \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"empty-response","failuresBeforeSuccess":1}'

curl -sS -X POST http://127.0.0.1:4010/__control/reset \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"sse-stream-error","failuresBeforeSuccess":1}'
```

验收重试耗尽，将所需场景的失败次数设为 3（也可设为更大的 N）：

```sh
curl -sS -X POST http://127.0.0.1:4010/__control/reset \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"empty-response","failuresBeforeSuccess":3}'
```

reset 的可选 JSON 只接受 `scenario` 和整数 `failuresBeforeSuccess`，省略字段保留原值，空正文或 `{}` 只重置计数。非法输入返回 HTTP 400，当前设置与计数不变。响应含 `responseAttempts`、`remainingFailures` 和 `nextOutcome`。

计数属于整个 mock 进程，不区分会话、Provider、模型或 API key。等当前请求结束后再 reset；每轮只验收一个模型调用，避免其它任务或并发对话共用此 mock。测试连接、额外的模型调用也会消耗次数。

## 界面验收

1. 确认正在运行的 Piskie 已包含 provider 默认有限重试及空响应判定修复。修改源码不代表运行中的 Electron 已更新；此服务不会重启开发环境。
2. 重置到所需场景，确认 `responseAttempts: 0`。
3. 新建对话并选中这个模型，发送一个只需文本回答的虚构短请求，例如“直接回复一句示例文本”。**通过新对话的实际模型调用验收重试**。界面“测试连接”是 `maxAttempts: 1` 的单次 smoke 请求，只能检查连通性；如先使用了它，验收前再次 reset。
4. 对照 mock 状态、日志和最终对话结果。默认单次调用 `maxAttempts: 3`，**包含首次请求**，最多额外重试两次：

| 失败次数 N | 同一次模型调用的预期 HTTP 请求数 | 预期结果 |
| --- | --- | --- |
| 0 | 1 | 直接成功 |
| 1 | 2 | 首次失败，第二次成功 |
| 2 | 3 | 第三次成功 |
| ≥3 | 3 | 第三次失败后结束，无第四次自动请求 |

成功时最终结果应为 `Mock retry succeeded.`；`sse-stream-error` 的部分文本可能短暂出现，但不应留在最终成功结果中。空响应失败应触发 `AI_RESULT_EMPTY`（`source=provider`、`stage=result`）；流错误保留 `upstream_stream_read_error`。只在最终成功时完成调用，耗尽时显示失败。多次模型调用或自定义重试策略会影响对话总请求数，应按单次调用判断。

N=3 耗尽后，服务的第 4 个独立请求会成功；重新验收故障前必须 reset。此服务仅提供 Responses SSE 场景。

## 独立测试

安装项目依赖后，在项目根目录运行：

```sh
node --test scripts/testing/openai-responses-fault-server.test.mjs
```

测试使用真实 OpenAI SDK（关闭 SDK 自身重试），验证流错误解析、空结果、失败次数、恢复、重复 reset 和非法控制输入，并覆盖原有场景。
