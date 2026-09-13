import { describe, expect, it } from 'vitest';
import { PLAN_GUIDE_DURATION, planGuideFrame, typedText } from '../planTimeline';

describe('plan guide story', () => {
  it('shows the selection before submission and feedback before the revised plan', () => {
    expect(planGuideFrame(2900)).toMatchObject({ scene: 'setup', menuOpen: true, planSelected: false });
    expect(planGuideFrame(3500)).toMatchObject({ scene: 'setup', planSelected: true });
    expect(planGuideFrame(8500)).toMatchObject({ scene: 'plan', gateOpacity: 1, revised: false });
    expect(planGuideFrame(11000)).toMatchObject({ scene: 'plan', feedbackVisible: true, revised: false });
    expect(planGuideFrame(15100)).toMatchObject({ scene: 'plan', feedbackVisible: false, revised: true });
    expect(planGuideFrame(18000)).toMatchObject({ scene: 'execution', revised: true });
  });

  it('fades the result before resetting the story and leaves no state from the prior loop', () => {
    expect(planGuideFrame(20225)).toMatchObject({ scene: 'execution', opacity: 0.5 });
    expect(planGuideFrame(20675)).toMatchObject({ scene: 'setup', opacity: 0.5, taskTyping: 0 });
    expect(planGuideFrame(PLAN_GUIDE_DURATION + 2900)).toEqual(planGuideFrame(2900));
  });

  it('types translated text without splitting Unicode code points', () => {
    expect(typedText('保留目录结构', 1)).toBe('保留目录结构');
    expect(typedText('Keep folders', 1)).toBe('Keep folders');
    expect(typedText('A\u{1F4C4}B', 2 / 3)).toBe('A\u{1F4C4}');
  });
});
