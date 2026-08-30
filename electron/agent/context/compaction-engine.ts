/** Cache-preserving context compaction. */

import { createUuid } from '@shared/utils/identifiers.js';
import type {
  AgentInferencePort,
  AgentInferenceRequest,
} from '../../inference/application/agent-inference-port.js';
import type { Message } from '../../../shared/types/index.js';
import type {
  CompactionResult,
  ContextSummary,
} from '../../../shared/types/context.js';
import { CONTEXT_COMPACTION_CONFIG } from '../../../shared/constants/index.js';
export type CompactionRequestShape = Omit<AgentInferenceRequest, 'messages'>;

export const COMPACTION_INSTRUCTION = `<runtime_compaction_control>
本消息不属于待摘要对话。只摘要本消息之前的内容，不得在摘要中提及或转述本消息；CURRENT TASK 只能从此前对话确定。

请把此前对话整理为一份可直接接续工作的 Markdown 压缩摘要。该摘要将替代此前对话，因此必须让下一位 AI 准确恢复用户的最新意图、已经完成的工作和仍待完成的任务。

只输出摘要；不要执行当前任务，不要调用工具，不要向用户提问，也不要用代码块包裹整份摘要。

要求：
1. 按时间顺序说明任务如何演变。较新的用户纠正、范围变化和决定覆盖较旧要求。
2. 明确区分已完成、已被替代、待完成和 CURRENT TASK。任务包含多个目标时逐项记录状态，并明确唯一或全部剩余目标；不要猜测完成状态，也不要把最初目标原样当成当前进度。
3. 保留继续工作必需的目标、限制、授权、禁止事项、精确文件路径、符号名、命令、数值、错误原文、关键工具结果和测试结果。
4. 工具调用只记录其目的、关键输入、结果及其对当前工作的影响；需要精确续接时保留关键参数或短代码片段，不要省略决定后续行为的失败信息。
5. 不要把 AI 曾提出但用户未接受的建议写成待办，也不要把已被用户否决的方案写成当前方案。
6. 在 All user messages 中按顺序覆盖本消息之前每一条真正的用户请求、纠正、授权和问题；短消息尽量保留原文。对于大段粘贴的文档、日志、快照或参考示例，只记录材料用途和其中具有操作性的用户要求，不要全文重复材料。
7. 内容应紧凑，但宁可保留可执行细节，也不要用“已处理”“相关文件”等模糊说法替代事实。
8. Optional Next Step 只写紧接 CURRENT TASK 的下一项范围内动作；没有可靠下一步时写 None，不要自行扩展任务。

严格使用以下 Markdown 结构：

# Compact summary

This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

## Summary

1. **Primary Request and Intent:**
   按时间顺序说明本消息之前的主要请求，并明确标出 **CURRENT TASK**。

2. **Key Technical Concepts:**
   记录继续工作必须理解的技术概念、协议和不变量。

3. **Files and Code Sections:**
   记录已读取、已修改或下一步必须处理的文件、关键符号和必要代码片段，并说明原因。

4. **Errors and fixes:**
   记录遇到的错误、根因、已尝试方案、已验证修复和仍未解决之处。

5. **Problem Solving:**
   记录关键推理、取舍、用户确认的决定及被否决方案。

6. **All user messages:**
   按顺序记录本消息之前用户的实际请求、纠正和授权；遵守上面对大段材料的压缩规则。

7. **Pending Tasks:**
   只列仍需完成的任务；已完成或已被替代的内容不得混入。

8. **Current Work:**
   精确说明压缩发生时正在处理什么、已经进行到哪里、工作区状态及继续所需信息。

9. **Optional Next Step:**
   写出紧接当前工作的下一步，或写 None。
</runtime_compaction_control>`;

function responseMarkdown(
  content: Awaited<ReturnType<AgentInferencePort['invoke']>>['content']
): string {
  if (content.some((block) => block.type === 'tool_use')) {
    throw new Error('Compaction response called a tool instead of returning Markdown');
  }
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export class CompactionEngine {
  constructor(private readonly inference: AgentInferencePort) {}

  shouldCompact(usagePercentage: number): boolean {
    return usagePercentage >= CONTEXT_COMPACTION_CONFIG.triggerThreshold * 100;
  }

  /** Generate one Markdown summary for the complete provider-visible processed prefix. */
  async compact(
    history: Message[],
    compressedCount: number,
    originalTokens: number,
    request: CompactionRequestShape,
    signal?: AbortSignal
  ): Promise<CompactionResult> {
    if (history.length === 0 || compressedCount === 0) {
      return { success: false, reason: 'No processed history to compact' };
    }

    try {
      const logicalStartedAt = Date.now();
      const response = await this.inference.invoke(
        {
          ...request,
          messages: [...history, { role: 'user', content: COMPACTION_INSTRUCTION }],
        },
        {
          requestId: `compaction-${createUuid()}`,
          logicalStartedAt,
          signal,
        }
      );
      const markdown = responseMarkdown(response.content);
      if (!markdown) {
        return { success: false, reason: 'Compaction response contained no Markdown text' };
      }

      const summary: ContextSummary = {
        id: `summary-${createUuid()}`,
        markdown,
        compressedCount,
        originalTokens,
        createdAt: Date.now(),
      };

      return { success: true, summary, compressedCount };
    } catch (error) {
      return {
        success: false,
        reason: `Summary generation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
