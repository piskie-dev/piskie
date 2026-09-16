import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MermaidConfig } from 'mermaid';
import { mermaidToPng, renderMermaid } from '../mermaidRuntime';

const mocks = vi.hoisted(() => ({
  loaded: vi.fn(),
  initialize: vi.fn<(config: MermaidConfig) => void>(),
  render: vi.fn<(id: string, source: string, container: Element) => Promise<{ svg: string }>>(),
}));
vi.mock('mermaid', () => {
  mocks.loaded();
  return { default: {
    initialize: mocks.initialize,
    render: mocks.render,
    mermaidAPI: {
      defaultConfig: { secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges'] },
      getConfig: () => ({ themeVariables: { background: '#ffffff' } }),
    },
  } };
});
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -20 1200 900" style="max-width: 1200px"><text>Example</text></svg>';
let dom: JSDOM;
beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('DOMParser', dom.window.DOMParser);
  vi.stubGlobal('XMLSerializer', dom.window.XMLSerializer);
});
beforeEach(() => {
  mocks.initialize.mockClear();
  mocks.render.mockReset().mockResolvedValue({ svg });
});
afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

describe('Mermaid rendering runtime', () => {
  it('loads Mermaid only when requested and retains full SVG bounds and embedded styles', async () => {
    expect(mocks.loaded).not.toHaveBeenCalled();
    const diagram = await renderMermaid('flowchart LR\nA --> B', 'light');
    expect(mocks.loaded).toHaveBeenCalledOnce();
    expect(diagram).toMatchObject({ width: 1200, height: 900 });
    const result = new DOMParser().parseFromString(diagram.svg, 'image/svg+xml').documentElement;
    expect(result.getAttribute('viewBox')).toBe('-10 -20 1200 900');
    expect(result.getAttribute('width')).toBe('1200');
    expect(result.getAttribute('height')).toBe('900');
    expect(result.textContent).toBe('Example');
    expect(document.body.children).toHaveLength(0);
  });

  it('serializes configuration with rendering and continues after a failed diagram', async () => {
    const first = deferred<{ svg: string }>();
    const started = deferred<void>();
    mocks.render.mockImplementationOnce(async () => { started.resolve(); return first.promise; });
    const firstResult = renderMermaid('invalid diagram', 'dark');
    const rejection = expect(firstResult).rejects.toThrow('Invalid source');
    const next = renderMermaid('flowchart LR\nA --> B', 'light');
    await started.promise;
    expect(mocks.initialize).toHaveBeenCalledTimes(1);
    expect(mocks.initialize.mock.calls[0]![0].theme).toBe('dark');
    expect(document.body.children).toHaveLength(1);
    first.reject(new Error('Invalid source'));
    await rejection;
    await next;
    expect(mocks.initialize.mock.calls.map(([config]) => config.theme)).toEqual(['dark', 'default']);
    expect(mocks.render.mock.calls[0]![0]).not.toBe(mocks.render.mock.calls[1]![0]);
    expect(document.body.children).toHaveLength(0);
  });

  it('protects application configuration from Mermaid source directives', async () => {
    await renderMermaid('flowchart LR\nA --> B', 'light');
    const config = mocks.initialize.mock.calls[0]![0];
    expect(config).toMatchObject({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, suppressErrorRendering: true });
    expect(config.secure).toEqual(expect.arrayContaining([
      'securityLevel', 'htmlLabels', 'theme', 'themeVariables', 'themeCSS', 'fontFamily', 'startOnLoad', 'maxTextSize', 'maxEdges',
    ]));
  });

  it('rejects an SVG without usable full bounds and cleans up its temporary measurement element', async () => {
    mocks.render.mockResolvedValueOnce({ svg: '<svg viewBox="0 0 0 0" />' });
    await expect(renderMermaid('flowchart LR\nA --> B', 'light')).rejects.toThrow('complete SVG viewBox');
    expect(document.body.children).toHaveLength(0);
  });
});

describe('Mermaid PNG generation', () => {
  it.each([false, true])('encodes full diagram dimensions and releases its SVG URL (encoding failure=%s)', async (fails) => {
    class LoadedImage {
      onload: (() => void) | undefined;
      set src(_url: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', LoadedImage);
    const url = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:example');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const drawImage = vi.fn();
    const context = vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const png = new Blob(['example PNG'], { type: 'image/png' });
    const dimensions: number[] = [];
    const encode = vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'toBlob')
      .mockImplementation(function (this: HTMLCanvasElement, callback) {
        dimensions.push(this.width, this.height);
        callback(fails ? null : png);
      });
    try {
      const result = mermaidToPng({ svg, width: 1200, height: 900 });
      if (fails) await expect(result).rejects.toThrow('encode');
      else await expect(result).resolves.toBe(png);
      expect(drawImage).toHaveBeenCalledWith(expect.any(LoadedImage), 0, 0, 2400, 1800);
      expect(dimensions).toEqual([2400, 1800]);
      expect(encode).toHaveBeenCalledWith(expect.any(Function), 'image/png');
      expect(revoke).toHaveBeenCalledWith('blob:example');
    } finally {
      url.mockRestore(); revoke.mockRestore(); context.mockRestore(); encode.mockRestore();
    }
  });
});
