/**
 * Bot 配置熔合（双玻璃名册档案 · 保存路径唯一入口）。
 *
 * 关键约束：
 * - 打底合并持久配置:表单未展示的字段(replyForward.toolFilter、allowFrom、
 *   groupSenderAllowFrom、corpId、agentId 等)一律原样保留,不因保存丢失
 * - Secret 留空 = 保留旧值(持久层有旧 secret 且表单为空串时不写键)
 * - 扫码渠道(weixin)无凭证:appId/appSecret 从结果中剥除
 * - 非静止(运行中等)禁止改绑:definitionId 强制保留持久值(后端另有
 *   task_definition_binding_locked 双闸,这里是前端侧的第一道)
 * - 群白名单仅 allowlist 策略时按行写入;其他策略保留持久值不动
 */

import type { MessagingConnectionConfig } from '../../../../shared/electron-contracts/messaging';

/** 档案表单值(DossierPane 的受控字段全集) */
export interface DossierFormValues {
  name: string;
  channelType: string;
  appId: string;
  /** 空串 = 不修改(保留持久层旧值) */
  appSecret: string;
  definitionId?: string;
  dmPolicy: NonNullable<MessagingConnectionConfig['dmPolicy']>;
  groupPolicy: NonNullable<MessagingConnectionConfig['groupPolicy']>;
  /** 群白名单多行文本(仅 allowlist 时生效) */
  groupAllowText: string;
  requireMention: boolean;
  forwardAssistantText: boolean;
  forwardToolCalls: boolean;
  forwardToolResults: boolean;
}

export interface FuseContext {
  /** 目标 Bot id(新建时由调用方生成后传入,保持本函数纯) */
  botId: string;
  /** 是否静止(stopped/error);非静止时 definitionId 锁定为持久值 */
  atRest: boolean;
  /** 扫码渠道(weixin):剥除凭证键 */
  scanLogin: boolean;
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 表单 + 持久配置 → 可提交的完整配置 */
export function fuseBotRecord(
  persisted: MessagingConnectionConfig | undefined,
  form: DossierFormValues,
  context: FuseContext,
): MessagingConnectionConfig {
  const fused: MessagingConnectionConfig = {
    ...persisted,
    id: context.botId,
    channelType: form.channelType,
    name: form.name.trim(),
    dmPolicy: form.dmPolicy,
    groupPolicy: form.groupPolicy,
    requireMention: form.requireMention,
    replyForward: {
      ...persisted?.replyForward,
      forwardAssistantText: form.forwardAssistantText,
      forwardToolCalls: form.forwardToolCalls,
      forwardToolResults: form.forwardToolResults,
    },
  };

  if (context.scanLogin) {
    delete fused.appId;
    delete fused.appSecret;
  } else {
    fused.appId = form.appId.trim();
    const secret = form.appSecret.trim();
    if (secret.length > 0) fused.appSecret = secret;
    // 空串:键沿用 persisted 展开的旧值(无旧值则键不存在)
  }

  if (context.atRest) {
    if (form.definitionId) fused.definitionId = form.definitionId;
    else delete fused.definitionId;
  } else if (persisted?.definitionId) {
    fused.definitionId = persisted.definitionId;
  }

  if (form.groupPolicy === 'allowlist') {
    fused.groupAllowFrom = splitLines(form.groupAllowText);
  }

  return fused;
}

/** 校验失败定位:messageKey 由 presenter 翻译，field 指认问题控件。 */
export interface FormFault {
  /** channel 仅由新建态的渠道选择产生(faultOfForm 不返回) */
  field: 'name' | 'definition' | 'appId' | 'appSecret' | 'channel';
  messageKey: string;
}

/** 保存前校验;返回失败定位,null = 通过 */
export function faultOfForm(
  form: DossierFormValues,
  options: { scanLogin: boolean; hasStoredSecret: boolean },
): FormFault | null {
  if (form.name.trim().length === 0) {
    return { field: 'name', messageKey: 'imPlugin.validation.botNameMissing' };
  }
  // UI 层保存必绑(2026-08-20 用户裁决:绑定语义只在交互上体现,不配说明文案);
  // 后端存档层的 definitionId 可选草稿语义保持不变,fuseBotRecord 仍支持解绑
  if (!form.definitionId) {
    return { field: 'definition', messageKey: 'imPlugin.validation.templateMissing' };
  }
  if (!options.scanLogin) {
    if (form.appId.trim().length === 0) {
      return { field: 'appId', messageKey: 'imPlugin.validation.appIdMissing' };
    }
    if (form.appSecret.trim().length === 0 && !options.hasStoredSecret) {
      return { field: 'appSecret', messageKey: 'imPlugin.validation.appSecretMissing' };
    }
  }
  return null;
}
