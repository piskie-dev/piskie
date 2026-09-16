/**
 * vendor 插件日志 → Piskie 应用日志的桥。
 *
 * 收编的上游渠道代码（如微信 util/logger.js）原本自行落盘到 OpenClaw 临时目录；
 * 存储隔离后统一经此转发到 appLog（<userData>/logs/app）。日志记录遵循项目的静态
 * 日志契约：event/message 为固定字面量，vendor 的动态文本放在 context.text。
 */

import { appLog } from '@electron/observability/logging/app-log.js';

export type VendorLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface VendorLogFields {
  /** 上游 logger 名（如 gateway/channels/openclaw-weixin/<accountId>） */
  readonly logger?: string;
  readonly accountId?: string;
}

export interface VendorLogSink {
  (level: VendorLogLevel, text: string, fields?: VendorLogFields): void;
}

const log = appLog.child({ scope: 'messaging.vendor' });

/** 为某个渠道创建日志汇（channel 为渠道 key，如 openclaw-weixin）。 */
export function createVendorLogSink(channel: string): VendorLogSink {
  return (level, text, fields) => {
    const logger = fields?.logger;
    const accountId = fields?.accountId;
    switch (level) {
      case 'debug':
        log.debug({
          event: 'messaging.vendor.line.debug',
          message: 'Vendor debug line',
          context: {
            channel,
            text,
            ...(logger !== undefined && { logger }),
            ...(accountId !== undefined && { accountId }),
          },
        });
        break;
      case 'info':
        log.info({
          event: 'messaging.vendor.line.info',
          message: 'Vendor info line',
          context: {
            channel,
            text,
            ...(logger !== undefined && { logger }),
            ...(accountId !== undefined && { accountId }),
          },
        });
        break;
      case 'warn':
        log.warn({
          event: 'messaging.vendor.line.warn',
          message: 'Vendor warning line',
          context: {
            channel,
            text,
            ...(logger !== undefined && { logger }),
            ...(accountId !== undefined && { accountId }),
          },
        });
        break;
      case 'error':
        log.error({
          event: 'messaging.vendor.line.error',
          message: 'Vendor error line',
          context: {
            channel,
            text,
            ...(logger !== undefined && { logger }),
            ...(accountId !== undefined && { accountId }),
          },
        });
        break;
    }
  };
}
