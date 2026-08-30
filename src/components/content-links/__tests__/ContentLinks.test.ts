import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentLinkHost, ContentLinkUrlScope, LinkedText } from '../ContentLinks';

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
const openExternal = vi.fn(async () => undefined);
const revealPath = vi.fn(async () => undefined);
const openLocalHtml = vi.fn(async () => undefined);
const openLocalFile = vi.fn(async () => undefined);
const desktopSystem = {
  platform: 'linux',
  openExternal,
  revealPath,
};

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://piskie.test' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('SVGElement', dom.window.SVGElement);
  vi.stubGlobal('MouseEvent', dom.window.MouseEvent);
  Object.assign(dom.window, {
    piskie: {
      desktop: {
        system: desktopSystem,
      },
    },
  });
});

beforeEach(() => {
  openExternal.mockClear();
  revealPath.mockClear();
  openLocalHtml.mockClear();
  openLocalFile.mockClear();
  desktopSystem.platform = 'linux';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

describe('content link activation', () => {
  it('opens a plain web URL through the provided side-browser callback', async () => {
    const openInSideBrowser = vi.fn();
    await act(async () => {
      root.render(
        createElement(
          ContentLinkHost,
          null,
          createElement(
            ContentLinkUrlScope,
            { onOpenUrl: openInSideBrowser },
            createElement(LinkedText, null, 'https://example.com'),
          ),
        ),
      );
    });

    const url = container.querySelector<HTMLElement>('[data-content-target="url"]')!;
    await act(async () => {
      url.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('打开链接 [Ctrl + 左键]');

    await act(async () => url.click());

    expect(openInSideBrowser).toHaveBeenCalledWith('https://example.com');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('uses the desktop actions for modified URL and path clicks', async () => {
    await act(async () => {
      root.render(createElement(LinkedText, null, 'https://example.com\n/home/user/report.txt'));
    });

    container.querySelector<HTMLElement>('[data-content-target="url"]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );
    container.querySelector<HTMLElement>('[data-content-target="path"]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );

    expect(openExternal).toHaveBeenCalledWith('https://example.com');
    expect(revealPath).toHaveBeenCalledWith('/home/user/report.txt');
  });

  it.each([
    '/home/user/site/index.html',
    '/home/user/site/index.HTM',
  ])('opens a local HTML path through the side-browser callback: %s', async (target) => {
    await act(async () => {
      root.render(
        createElement(
          ContentLinkUrlScope,
          { onOpenLocalHtml: openLocalHtml },
          createElement(LinkedText, null, target),
        ),
      );
    });

    const path = container.querySelector<HTMLElement>('[data-content-target="path"]')!;
    await act(async () => path.click());

    expect(openLocalHtml).toHaveBeenCalledWith(target);
    expect(revealPath).not.toHaveBeenCalled();
  });

  it('previews a non-HTML local path through the provided file callback', async () => {
    const target = '/home/user/docs/ROADMAP.md';
    await act(async () => {
      root.render(
        createElement(
          ContentLinkHost,
          null,
          createElement(
            ContentLinkUrlScope,
            { onOpenLocalFile: openLocalFile },
            createElement(LinkedText, null, target),
          ),
        ),
      );
    });

    const path = container.querySelector<HTMLElement>('[data-content-target="path"]')!;
    await act(async () => {
      path.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('单击预览文件；Ctrl + 左键定位文件');

    await act(async () => path.click());

    expect(openLocalFile).toHaveBeenCalledWith(target);
    expect(revealPath).not.toHaveBeenCalled();

    path.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    expect(revealPath).toHaveBeenCalledWith(target);
    expect(openLocalFile).toHaveBeenCalledTimes(1);
  });

  it('prefers the HTML opener over the generic file preview', async () => {
    await act(async () => {
      root.render(
        createElement(
          ContentLinkUrlScope,
          { onOpenLocalHtml: openLocalHtml, onOpenLocalFile: openLocalFile },
          createElement(LinkedText, null, '/home/user/site/index.html'),
        ),
      );
    });

    await act(async () => container.querySelector<HTMLElement>('[data-content-target="path"]')!.click());

    expect(openLocalHtml).toHaveBeenCalledWith('/home/user/site/index.html');
    expect(openLocalFile).not.toHaveBeenCalled();
  });

  it('describes both local HTML click actions in the hover hint', async () => {
    await act(async () => {
      root.render(
        createElement(
          ContentLinkHost,
          null,
          createElement(
            ContentLinkUrlScope,
            { onOpenLocalHtml: openLocalHtml },
            createElement(LinkedText, null, '/home/user/site/index.html'),
          ),
        ),
      );
    });

    const path = container.querySelector<HTMLElement>('[data-content-target="path"]')!;
    await act(async () => {
      path.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('单击预览网页；Ctrl + 左键定位文件');
  });

  it('keeps modified local HTML clicks mapped to file reveal', async () => {
    const target = '/home/user/site/index.html';
    await act(async () => {
      root.render(
        createElement(
          ContentLinkUrlScope,
          { onOpenLocalHtml: openLocalHtml },
          createElement(LinkedText, null, target),
        ),
      );
    });

    container.querySelector<HTMLElement>('[data-content-target="path"]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );

    expect(revealPath).toHaveBeenCalledWith(target);
    expect(openLocalHtml).not.toHaveBeenCalled();
  });

  it('shows the shared hover hint for external URLs and for file paths', async () => {
    await act(async () => {
      root.render(
        createElement(
          ContentLinkHost,
          null,
          createElement(LinkedText, null, 'https://example.com\n/home/user/report.txt'),
        ),
      );
    });

    const url = container.querySelector<HTMLElement>('[data-content-target="url"]')!;
    await act(async () => {
      url.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('打开链接 [Ctrl + 左键]');

    const path = container.querySelector<HTMLElement>('[data-content-target="path"]')!;
    await act(async () => {
      url.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: path }));
      path.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: url }));
    });
    expect(document.body.textContent).toContain('定位文件 [Ctrl + 左键]');
    expect(openExternal).not.toHaveBeenCalled();
    expect(revealPath).not.toHaveBeenCalled();
  });

  it('uses Command on macOS for both the hint and activation', async () => {
    desktopSystem.platform = 'darwin';
    await act(async () => {
      root.render(
        createElement(
          ContentLinkHost,
          null,
          createElement(LinkedText, null, 'https://example.com'),
        ),
      );
    });

    const url = container.querySelector<HTMLElement>('[data-content-target="url"]')!;
    await act(async () => {
      url.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('打开链接 [⌘ + 点击]');

    await act(async () => {
      url.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    });
    expect(openExternal).not.toHaveBeenCalled();

    await act(async () => {
      url.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    });
    expect(openExternal).toHaveBeenCalledWith('https://example.com');
  });
});
