/**
 * EnvStudio 数据层 · 站点图鉴
 *
 * 常用站点的域名 → 品牌名解析，供登录痕迹 chips 显示人话名称；
 * 未收录域名回退为域名本身。纯静态字典，不发网络请求。
 */

const SITE_NAMES: Record<string, string> = {
  // 国内社交/内容
  'xiaohongshu.com': '小红书',
  'weibo.com': '微博',
  'douyin.com': '抖音',
  'kuaishou.com': '快手',
  'bilibili.com': '哔哩哔哩',
  'zhihu.com': '知乎',
  'douban.com': '豆瓣',
  'qq.com': 'QQ',
  'weixin.qq.com': '微信',
  '163.com': '网易',
  'sina.com.cn': '新浪',
  'baidu.com': '百度',
  'toutiao.com': '今日头条',
  // 电商
  'taobao.com': '淘宝',
  'tmall.com': '天猫',
  'jd.com': '京东',
  'pinduoduo.com': '拼多多',
  'yangkeduo.com': '拼多多',
  'goofish.com': '闲鱼',
  '1688.com': '1688',
  'alipay.com': '支付宝',
  'aliexpress.com': 'AliExpress',
  'amazon.com': 'Amazon',
  'shopee.com': 'Shopee',
  'shopee.co.id': 'Shopee',
  'shopee.tw': 'Shopee',
  'mercadolibre.com': 'Mercado Libre',
  'mercadolibre.com.mx': 'Mercado Libre',
  'mercadolivre.com.br': 'Mercado Livre',
  'temu.com': 'Temu',
  'shein.com': 'SHEIN',
  'lazada.com': 'Lazada',
  // 海外社交/工具
  'google.com': 'Google',
  'youtube.com': 'YouTube',
  'facebook.com': 'Facebook',
  'instagram.com': 'Instagram',
  'x.com': 'X',
  'twitter.com': 'X',
  'tiktok.com': 'TikTok',
  'whatsapp.com': 'WhatsApp',
  'telegram.org': 'Telegram',
  'discord.com': 'Discord',
  'reddit.com': 'Reddit',
  'linkedin.com': 'LinkedIn',
  'netflix.com': 'Netflix',
  'github.com': 'GitHub',
  'stackoverflow.com': 'Stack Overflow',
  'openai.com': 'OpenAI',
  'anthropic.com': 'Anthropic',
  'bing.com': '必应',
};

export interface SiteFace {
  /** 品牌名；未收录时为 null（显示域名） */
  name: string | null;
  /** 徽章字符：中文名取首字，其余取首字母大写 */
  badge: string;
  host: string;
}

export function resolveSiteFace(host: string): SiteFace {
  const name = SITE_NAMES[host] ?? null;
  const seed = name ?? host;
  const first = [...seed][0] ?? '?';
  const badge = /[a-z]/i.test(first) ? first.toUpperCase() : first;
  return { name, badge, host };
}
