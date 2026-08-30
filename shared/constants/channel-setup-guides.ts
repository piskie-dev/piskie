/**
 * IM 渠道使用指引配置
 * IM 渠道共享使用指引。
 */

import type { SetupGuide } from '../types/setup-guide.js';

export const CHANNEL_SETUP_GUIDES: Record<string, SetupGuide> = {
  qqbot: {
    consoleURL: 'https://q.qq.com/',
    steps: [
      {
        title: '登录 QQ 开放平台',
        description: '前往 QQ 开放平台，使用手机 QQ 扫描页面二维码即可注册/登录。',
        link: { text: 'QQ 开放平台', url: 'https://q.qq.com/' },
      },
      {
        title: '创建 QQ 机器人',
        description: '登录后点击「创建机器人」，即可新建一个 QQ 机器人。',
      },
      {
        title: '获取 AppID 和 AppSecret',
        description: '在机器人页面找到 AppID 和 AppSecret，点击复制并妥善保存。AppSecret 离开页面后会强制重置，请务必立即保存。',
      },
    ],
    notes: [
      '平台默认启用 IP 白名单，需要在开放平台配置你的出口公网 IP 才能连接',
      '每个 QQ 账号最多可创建 5 个机器人',
      '企业主体支持频道+群场景；个人主体仅支持频道场景',
      '机器人使用 WebSocket 长连接，无需公网域名或配置 Webhook',
    ],
    links: [
      { text: 'QQ 机器人官方文档', url: 'https://bot.q.qq.com/wiki/' },
      { text: 'API v2 接入文档', url: 'https://bot.q.qq.com/wiki/develop/api-v2/' },
      { text: '官方 OpenClaw 插件', url: 'https://github.com/tencent-connect/openclaw-qqbot' },
    ],
  },
  feishu: {
    consoleURL: 'https://open.feishu.cn/app',
    steps: [
      {
        title: '登录飞书开放平台',
        description: '前往飞书开放平台，使用飞书账号登录开发者后台。',
        link: { text: '飞书开放平台', url: 'https://open.feishu.cn/' },
      },
      {
        title: '创建企业自建应用',
        description: '点击「创建应用」→ 选择「企业自建应用」，填写应用名称和描述。',
      },
      {
        title: '添加机器人能力',
        description: '进入应用详情 →「添加应用能力」→ 选择「机器人」，即可为应用添加机器人能力。',
      },
      {
        title: '获取 App ID 和 App Secret',
        description: '在应用详情的「凭证与基础信息」页面，复制 App ID 和 App Secret。',
      },
    ],
    notes: [
      '应用需要发布后才能在飞书客户端中使用，开发阶段可使用测试企业',
      '需要在「事件与回调」中配置事件订阅，机器人才能接收消息',
      '确保在「权限管理」中开通所需的 API 权限（如 im:message:receive_v1）',
    ],
    links: [
      { text: '飞书机器人开发文档', url: 'https://open.feishu.cn/document/client-docs/bot-v3/bot-overview' },
      { text: '自建应用开发流程', url: 'https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process' },
    ],
  },
  wecom: {
    consoleURL: 'https://work.weixin.qq.com/wework_admin/frame#apps',
    steps: [
      {
        title: '登录企业微信管理后台',
        description: '使用管理员账号登录企业微信管理后台。',
        link: { text: '企业微信管理后台', url: 'https://work.weixin.qq.com/wework_admin/frame' },
      },
      {
        title: '创建智能机器人',
        description: '进入「安全与管理 → 管理工具 → 智能机器人」，点击「创建机器人」→ 手动创建 → 滑到底部选择「API 模式」→ 连接方式选「使用长连接」。',
        link: { text: '智能机器人文档', url: 'https://developer.work.weixin.qq.com/document/path/101463' },
      },
      {
        title: '获取 Bot ID 和 Secret',
        description: '创建完成后页面会显示 Bot ID（格式如 aib-xxx）和 Secret，将它们填入下方对应字段。',
      },
    ],
    notes: [
      '必须创建「智能机器人」（API 模式 + 长连接），普通自建应用的凭证无法使用',
      '同一个 Bot ID 同时只允许一个活跃连接，请勿在多个实例中重复使用',
      '当前仅支持配置一个企业微信 Bot',
    ],
    links: [
      { text: '长连接文档', url: 'https://developer.work.weixin.qq.com/document/path/101463' },
      { text: 'OpenClaw 接入指南', url: 'https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21657' },
    ],
  },
};
