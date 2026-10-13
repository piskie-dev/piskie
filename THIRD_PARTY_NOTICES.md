# Third-Party Notices

This source distribution includes the following vendored or adapted third-party code.

## MIT

| Component | Source record | License |
|---|---|---|
| Feishu channel vendor | [UPSTREAM](electron/im-gateway/channels/feishu/UPSTREAM.md) | [MIT](electron/im-gateway/channels/feishu/vendor/LICENSE) |
| QQ Bot channel vendor | [UPSTREAM](electron/im-gateway/channels/qqbot/UPSTREAM.md) | [MIT](electron/im-gateway/channels/qqbot/vendor/LICENSE) |
| Weixin channel vendor | [UPSTREAM](electron/im-gateway/channels/weixin/UPSTREAM.md) | [MIT](electron/im-gateway/channels/weixin/vendor/LICENSE) |
| WeCom channel vendor | [UPSTREAM](electron/im-gateway/channels/wecom/UPSTREAM.md) | [MIT](electron/im-gateway/channels/wecom/vendor/LICENSE) |
| OpenClaw compatibility code | [Source record](electron/im-gateway/core/openclaw-compat/README.md) | [MIT](electron/im-gateway/core/openclaw-compat/LICENSE) |

## Apache-2.0

Piskie's browser automation runtime contains source-adapted portions of
[chrome-devtools-mcp 1.10.1](https://github.com/ChromeDevTools/chrome-devtools-mcp/tree/e52c6b59b476c5e04d8dd9fd4bd017ba3b3d65df),
from tag `chrome-devtools-mcp-v1.10.1`, commit `e52c6b59b476c5e04d8dd9fd4bd017ba3b3d65df`
(2026-09-23). The adapted scope includes page/session and snapshot handling, action/input/navigation,
model tool schemas and result text, and console/network/screenshot/script observations.
Piskie retains its browser manager, public Skill SDK, feedback/screen and workspace/temp file owners.
The version identifies the upstream source release; `chrome-devtools-mcp` is not an npm runtime dependency.

| Source record | License | Attribution |
|---|---|---|
| [1.10.1 provenance](electron/piskiepilot/browser/third_party/chrome-devtools-mcp-1.10.1/provenance.json) | [Apache-2.0](electron/piskiepilot/browser/third_party/chrome-devtools-mcp-1.10.1/LICENSE) | [NOTICE](electron/piskiepilot/browser/third_party/chrome-devtools-mcp-1.10.1/NOTICE) |
| [1.7.0 historical baseline provenance](electron/piskiepilot/browser/third_party/chrome-devtools-mcp-1.7.0/provenance.json) | [Apache-2.0](electron/piskiepilot/browser/third_party/chrome-devtools-mcp-1.7.0/LICENSE) | [NOTICE](electron/piskiepilot/browser/third_party/chrome-devtools-mcp-1.7.0/NOTICE) |

The 1.7.0 record preserves earlier source attribution and the retained keyboard and file-root helpers.
Current 1.10.1 adaptations and the separately built frontend subset have their own records.

## DevTools frontend observation subset

The browser observation helpers include a separately built Node subset of
[DevTools frontend](https://github.com/ChromeDevTools/devtools-frontend/tree/61277feec01840bfa7cffb21d90bed500f973c70),
pinned to commit `61277feec01840bfa7cffb21d90bed500f973c70` by `chrome-devtools-mcp-v1.10.1`.
It supplies console issue mapping/aggregation, mapped stacks/source maps and issue descriptions.
Its [primary license is BSD-3-Clause](electron/piskiepilot/browser/third_party/devtools-frontend-61277fe/LICENSE);
the local MCP-derived bootstrap and build shims carry
[Apache-2.0](electron/piskiepilot/browser/third_party/devtools-frontend-61277fe/LICENSE-APACHE).
The [NOTICE](electron/piskiepilot/browser/third_party/devtools-frontend-61277fe/NOTICE)
preserves source copyright and embedded attribution. The
[provenance](electron/piskiepilot/browser/third_party/devtools-frontend-61277fe/provenance.json)
records 220 contributing source inputs, three JavaScript artifacts and 255 issue descriptions.

All included package license files are linked below; their embedded notices remain part of the distribution.

| Included component | License and retained notices |
|---|---|
| acorn | [MIT](electron/piskiepilot/browser/third_party/devtools-frontend-61277fe/licenses/acorn/LICENSE) |
| CodeMirror | [MIT](electron/piskiepilot/browser/third_party/devtools-frontend-61277fe/licenses/codemirror/LICENSE) |
| i18n | [Apache-2.0](electron/piskiepilot/browser/third_party/devtools-frontend-61277fe/licenses/i18n/LICENSE) |
| intl-messageformat | BSD-3-Clause: [LICENSE](electron/piskiepilot/browser/third_party/devtools-frontend-61277fe/licenses/intl-messageformat/LICENSE), [LICENSE.md](electron/piskiepilot/browser/third_party/devtools-frontend-61277fe/licenses/intl-messageformat/LICENSE.md) |
| marked | [MIT and retained Markdown BSD notice](electron/piskiepilot/browser/third_party/devtools-frontend-61277fe/licenses/marked/LICENSE) |
| source-map-scopes-codec | [BSD-3-Clause](electron/piskiepilot/browser/third_party/devtools-frontend-61277fe/licenses/source-map-scopes-codec/LICENSE) |
| wasmparser | [Apache-2.0](electron/piskiepilot/browser/third_party/devtools-frontend-61277fe/licenses/wasmparser/LICENSE) |

Bundled license comments, including Microsoft helper permissions, are preserved in
[observation.js.LEGAL.txt](electron/piskiepilot/browser/third_party/devtools-frontend-61277fe/observation.js.LEGAL.txt),
[formatter-worker.js.LEGAL.txt](electron/piskiepilot/browser/third_party/devtools-frontend-61277fe/formatter-worker.js.LEGAL.txt), and
[wasmparser-worker.js.LEGAL.txt](electron/piskiepilot/browser/third_party/devtools-frontend-61277fe/wasmparser-worker.js.LEGAL.txt).

Dependencies referenced only through `package.json` are not vendored into this source tree
and are not enumerated here. Packaged application distributions require their own generated
dependency notices.
