/** ImageReview 必须把节点动作发给持有节点的 Main/Worker Runtime。 */
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImageNodePublicState } from '../../../../../shared/types';
import type { InferenceConfig } from '../../../../../shared/types/inference';
import { useInferenceStore } from '../../../../store/inferenceStore';
import { ImageReview } from '../ImageReview';

const node: ImageNodePublicState = {
  id: 'image-node-1',
  status: 'preview',
  target: { providerId: 'provider-1', modelId: 'image-1' },
  createdAt: 1,
  images: [],
};

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
let approve: ReturnType<typeof vi.fn>;

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('Event', dom.window.Event);
  vi.stubGlobal('MouseEvent', dom.window.MouseEvent);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

beforeEach(() => {
  approve = vi.fn(async () => undefined);
  Object.defineProperty(dom.window, 'piskie', {
    configurable: true,
    value: { agents: { images: { approve } } },
  });
  useInferenceStore.setState({
    config: { providers: {} } as InferenceConfig,
    models: { ai: [], image: [] },
    availableTargets: { ai: [], image: [] },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useInferenceStore.setState({ config: null });
  vi.restoreAllMocks();
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

async function confirm(target: { agentId: string; workerId?: string }): Promise<void> {
  await act(async () => {
    root.render(createElement(ImageReview, { target, node }));
  });
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.includes('确认全部'),
  );
  if (!button) throw new Error('确认全部按钮未渲染');
  await act(async () => button.click());
}

describe('ImageReview Runtime owner', () => {
  it('Worker 节点把动作提交给 Worker Runtime', async () => {
    await confirm({ agentId: 'main-1', workerId: 'worker-1' });
    expect(approve).toHaveBeenCalledWith('worker-1', 'image-node-1');
  });

  it('主节点仍把动作提交给主 Agent Runtime', async () => {
    await confirm({ agentId: 'main-1' });
    expect(approve).toHaveBeenCalledWith('main-1', 'image-node-1');
  });
});
