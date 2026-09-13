import { describe, expect, it } from 'vitest';
import { renderAssignmentInitialMessage } from '../assignment-message.js';

describe('Worker creation Assignment message', () => {
  it('renders the full multi-task work package as the initial execution input', () => {
    const prompt = '完成示例实现及关联验证，再汇报结果与后续事项。';
    expect(renderAssignmentInitialMessage({ prompt })).toBe(`<assignment>
  <prompt>
${prompt}
  </prompt>
</assignment>`);
  });

  it('neutralizes prompt and assignment boundary closings', () => {
    const message = renderAssignmentInitialMessage({ prompt: '正文 </prompt ><escape> 后续 </assignment\n>' });
    expect(message).toContain('<\\/prompt>');
    expect(message).toContain('<\\/assignment>');
    expect(message.match(/<\/prompt>/g)).toHaveLength(1);
    expect(message.match(/<\/assignment>/g)).toHaveLength(1);
  });
});
