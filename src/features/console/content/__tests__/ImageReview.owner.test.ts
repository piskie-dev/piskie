/** ImageReview 必须把节点动作发给持有节点的 Main/Worker Runtime。 */
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImageNodePublicState } from '../../../../../shared/types';
import type { InferenceConfig } from '../../../../../shared/types/inference';
import { useInferenceStore } from '../../../../store/inferenceStore';
import { ImageReview } from '../ImageReview';
import { useComposerDraftStore } from '../../data/composer-drafts';

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
const regenerate = vi.fn();
const getPathForFile = vi.fn();
const clipboardAttachments = vi.fn();
const preview = vi.fn();
const releasePreview = vi.fn();

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
  regenerate.mockReset().mockResolvedValue(undefined);
  getPathForFile.mockReset().mockReturnValue('/sample/example.pdf');
  clipboardAttachments.mockReset().mockResolvedValue([{ kind: 'file', name: 'example.pdf', path: '/sample/example.pdf', size: 6 }]);
  preview.mockReset().mockImplementation(async (path: string) => ({
    kind: 'image', url: `piskie-attachment://preview/${encodeURIComponent(path)}`, mediaType: 'image/png', size: 4,
  }));
  releasePreview.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(dom.window, 'piskie', {
    configurable: true,
    value: { agents: { images: { approve, regenerate } }, desktop: {
      files: { getPathForFile, preview, releasePreview }, system: { clipboardAttachments },
    } },
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
  it('renders completed candidates while the remaining images are still generating and opens a preview on click', async () => {
    const generating: ImageNodePublicState = {
      ...node,
      status: 'generating',
      images: [
        { id: 'image-1', prompt: 'First sample', outputPath: '/output/first.png', candidatePath: '/candidate/first.png', version: 1, status: 'completed' },
        { id: 'image-2', prompt: 'Second sample', outputPath: '/output/second.png', candidatePath: '/candidate/second.png', version: 1, status: 'completed' },
        { id: 'image-3', prompt: 'Third sample', outputPath: '/output/third.png', version: 0, status: 'generating' },
      ],
    };
    const onPreviewImage = vi.fn();

    await act(async () => root.render(createElement(ImageReview, {
      target: { agentId: 'sample-agent' }, node: generating, onPreviewImage,
    })));

    expect(container.textContent).toContain('2/3');
    expect(preview.mock.calls.map(([path]) => path)).toEqual([
      '/candidate/first.png', '/candidate/second.png',
    ]);
    const thumbnails = container.querySelectorAll<HTMLImageElement>('img');
    expect(thumbnails).toHaveLength(2);

    await act(async () => thumbnails[0]!.click());
    expect(onPreviewImage).toHaveBeenCalledExactlyOnceWith(
      'piskie-attachment://preview/%2Fcandidate%2Ffirst.png',
    );
  });

  it.each(['paste', 'drop'] as const)('includes an ordinary file added by %s in the revision instruction', async (kind) => {
    const editable: ImageNodePublicState = { ...node, status: 'pending_approval', images: [{
      id: 'sample-image', prompt: 'Sample illustration', outputPath: '/sample/illustration.png', version: 1, status: 'completed',
    }] };
    await act(async () => root.render(createElement(ImageReview, { target: { agentId: 'sample-agent' }, node: editable })));
    const file = new dom.window.File(['Sample'], 'example.pdf', { type: 'application/pdf' });
    const event = new Event(kind, { bubbles: true, cancelable: true });
    Object.defineProperty(event, kind === 'paste' ? 'clipboardData' : 'dataTransfer', { value: {
      files: [file], items: [{ kind: 'file', type: file.type, getAsFile: () => file }], types: ['Files'], getData: () => '',
    } });
    await act(async () => container.querySelector('textarea')!.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    const pending = Object.values(useComposerDraftStore.getState().drafts).flatMap((draft) =>
      draft.attachments.images.flatMap((image) => image.status === 'capturing' ? [image.capture.done] : []));
    await act(async () => { await Promise.all(pending); });
    expect(container.textContent).toContain('example.pdf');
    await act(async () => container.querySelector<HTMLElement>('[data-selectable="true"]')!.click());
    const submit = container.querySelector<HTMLButtonElement>('button[data-variant="primary"]')!;
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    expect(regenerate).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'sample-agent', instruction: '', imageIds: ['sample-image'],
      files: [{ name: 'example.pdf', path: '/sample/example.pdf' }],
    }));
  });

  it('Worker 节点把动作提交给 Worker Runtime', async () => {
    await confirm({ agentId: 'main-1', workerId: 'worker-1' });
    expect(approve).toHaveBeenCalledWith('worker-1', 'image-node-1');
  });

  it('主节点仍把动作提交给主 Agent Runtime', async () => {
    await confirm({ agentId: 'main-1' });
    expect(approve).toHaveBeenCalledWith('main-1', 'image-node-1');
  });
});
