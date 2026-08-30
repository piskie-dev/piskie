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

Piskie's browser automation runtime contains adapted portions of `chrome-devtools-mcp`.
Its [NOTICE](electron/piskiepilot/browser/third_party/chrome-devtools-mcp-1.7.0/NOTICE),
[license](electron/piskiepilot/browser/third_party/chrome-devtools-mcp-1.7.0/LICENSE), and
[provenance](electron/piskiepilot/browser/third_party/chrome-devtools-mcp-1.7.0/provenance.json)
are maintained next to the derived-code record.

Dependencies referenced only through `package.json` are not vendored into this source tree
and are not enumerated here. Packaged application distributions require their own generated
dependency notices.
