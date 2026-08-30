import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

const mocks = vi.hoisted(() => {
  const getContext = vi.fn();
  const runExclusive = vi.fn(
    async (
      browserId: string,
      operation: (session: { automation: unknown; browser: unknown }) => Promise<unknown>
    ) => operation({ automation: getContext(browserId), browser: {} })
  );
  const navigateTo = vi.fn(async () => ({
    type: 'url' as const,
    url: 'https://example.test/current',
    title: 'Example',
    receipt: {
      navigated: true,
      domSettled: true,
      openedPageIds: [],
      closedPageIds: [],
    },
  }));
  const pressKey = vi.fn(async () => 'pressed');
  const takeSnapshot = vi.fn(async () => 'snapshot');
  return {
    getContext,
    runExclusive,
    navigateTo,
    pressKey,
    takeSnapshot,
  };
});

vi.mock('../../core/browser/browser-manager.js', () => ({
  BrowserManager: {
    runExclusive: mocks.runExclusive,
    getContext: mocks.getContext,
  },
}));

vi.mock('../../core/browser/browser-operations.js', () => ({
  BrowserOperations: { navigate: mocks.navigateTo },
}));

import { createGeneratedBrowserSkillRuntime } from '../generated-skill-browser.js';
import { BROWSER_SKILL_SDK_REFERENCE } from '../generated-skill-browser-reference.js';

describe('generated Browser Skill facade', () => {
  const log = vi.fn();
  const notifyPageOpen = vi.fn();
  let controller: AbortController;
  let page: ReturnType<typeof makePage>;
  let context: {
    getSelectedPage: ReturnType<typeof vi.fn>;
    listPages: ReturnType<typeof vi.fn>;
    getSelectedPageIndex: ReturnType<typeof vi.fn>;
    selectPageByIndex: ReturnType<typeof vi.fn>;
    waitForAction: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new AbortController();
    page = makePage();
    context = {
      getSelectedPage: vi.fn(() => page),
      listPages: vi.fn(async () => [{ pageId: 1, page, navigationSequence: 0 }]),
      getSelectedPageIndex: vi.fn(() => 0),
      selectPageByIndex: vi.fn(async (pageIdx: number) => {
        if (pageIdx !== 0) throw new Error('No page found');
        return page;
      }),
      waitForAction: vi.fn(async (action: () => Promise<unknown>) => {
        await action();
      }),
    };
    mocks.getContext.mockReturnValue(context);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function runtime() {
    return createGeneratedBrowserSkillRuntime({
      browserId: 'browser-bound-by-host',
      signal: controller.signal,
      log,
      notifyPageOpen,
    });
  }

  it('exposes only the controlled browser surface and injects host IDs for navigation', async () => {
    const browser = runtime();

    expect(Object.keys(browser)).toEqual(['page', 'listPages', 'selectPage']);
    expect(Object.keys(browser.page)).toEqual([
      'navigate',
      'currentPage',
      'click',
      'doubleClick',
      'hover',
      'fill',
      'select',
      'press',
      'waitFor',
      'extractText',
      'extractList',
    ]);
    expect(Object.isFrozen(browser)).toBe(true);
    expect(Object.isFrozen(browser.page)).toBe(true);
    expect(browser).not.toHaveProperty('core');
    expect(browser).not.toHaveProperty('browserId');
    expect(browser.page).not.toHaveProperty('binding');
    expect(browser.page).not.toHaveProperty('withSelectedPage');

    await expect(
      browser.page.navigate('https://example.test/path', { timeoutMs: 1234 })
    ).resolves.toEqual({ url: 'https://example.test/current', title: 'Example' });
    expect(mocks.navigateTo).toHaveBeenCalledWith({
      browserId: 'browser-bound-by-host',
      url: 'https://example.test/path',
      timeout: 1234,
      signal: controller.signal,
    });
    expect(mocks.runExclusive).not.toHaveBeenCalled();
    expect(notifyPageOpen).toHaveBeenCalledOnce();
    expect(mocks.takeSnapshot).not.toHaveBeenCalled();
  });

  it('lists fresh tabs and switches logical selection using browser page indices', async () => {
    const detailPage = makePage();
    detailPage.url.mockReturnValue('https://example.test/detail');
    detailPage.title.mockResolvedValue('Detail');
    const pages = [page, detailPage];
    let selectedPageIdx = 0;
    context.listPages.mockResolvedValue(
      pages.map((listedPage, pageId) => ({ pageId, page: listedPage, navigationSequence: 0 }))
    );
    context.getSelectedPageIndex.mockImplementation(() => selectedPageIdx);
    context.selectPageByIndex.mockImplementation(async (pageIdx: number) => {
      const selected = pages[pageIdx];
      if (!selected) throw new Error('No page found');
      selectedPageIdx = pageIdx;
      return selected;
    });
    context.getSelectedPage.mockImplementation(() => pages[selectedPageIdx]);
    const browser = runtime();

    await expect(browser.listPages()).resolves.toEqual([
      {
        pageIdx: 0,
        selected: true,
        url: 'https://example.test/current',
        title: 'Example',
      },
      {
        pageIdx: 1,
        selected: false,
        url: 'https://example.test/detail',
        title: 'Detail',
      },
    ]);
    await expect(browser.selectPage(1)).resolves.toEqual({
      url: 'https://example.test/detail',
      title: 'Detail',
    });
    await expect(browser.page.currentPage()).resolves.toEqual({
      url: 'https://example.test/detail',
      title: 'Detail',
    });

    expect(context.listPages).toHaveBeenCalledOnce();
    expect(context.selectPageByIndex).toHaveBeenCalledWith(1);
    expect(detailPage.bringToFront).not.toHaveBeenCalled();
  });

  it('rejects invalid page indices before touching the browser session', async () => {
    const browser = runtime();

    await expect(browser.selectPage(-1)).rejects.toThrow(
      'Browser Skill pageIdx must be a non-negative integer'
    );
    await expect(browser.selectPage(1.5)).rejects.toThrow(
      'Browser Skill pageIdx must be a non-negative integer'
    );
    expect(mocks.runExclusive).not.toHaveBeenCalled();
  });

  it('rejects accessibility-only roles before touching the browser session', async () => {
    await expect(
      runtime().page.click({ role: 'StaticText', name: 'Submit' }, { timeoutMs: 0 })
    ).rejects.toThrow('Accessibility snapshot role "StaticText" is not a DOM locator role');

    expect(mocks.runExclusive).not.toHaveBeenCalled();
    expect(mocks.takeSnapshot).not.toHaveBeenCalled();
  });

  it('tries stable locator fallbacks in order and disposes every handle', async () => {
    const missing = makeHandle(null);
    const element = makeElement();
    const found = makeHandle(element);
    page.evaluateHandle.mockResolvedValueOnce(missing).mockResolvedValueOnce(found);

    await runtime().page.fill(
      [{ css: '[data-testid="missing"]' }, { role: 'textbox', name: 'Search' }],
      'query',
      { timeoutMs: 50 }
    );

    expect(page.evaluateHandle.mock.calls.map((call) => call[1])).toEqual([
      {
        candidates: [{ kind: 'css', css: '[data-testid="missing"]' }],
        state: 'visible',
      },
      {
        candidates: [{ kind: 'role', role: 'textbox', name: { kind: 'literal', value: 'Search' } }],
        state: 'visible',
      },
    ]);
    expect(missing.dispose).toHaveBeenCalledOnce();
    expect(element.locator.fill).toHaveBeenCalledWith('query');
    expect(element.dispose).toHaveBeenCalledOnce();
    expect(mocks.getContext).toHaveBeenCalledWith('browser-bound-by-host');
  });

  it('does not retry a side effect after a locator matched and the action failed', async () => {
    const element = makeElement();
    element.locator.click.mockRejectedValueOnce(new Error('page changed during click'));
    page.evaluateHandle.mockResolvedValue(makeHandle(element));

    await expect(
      runtime().page.click({ role: 'button', name: 'Submit' }, { timeoutMs: 50 })
    ).rejects.toThrow('page changed during click');

    expect(element.locator.click).toHaveBeenCalledOnce();
    expect(element.locator.click).toHaveBeenCalledWith({ count: 1 });
    expect(page.evaluateHandle).toHaveBeenCalledOnce();
  });

  it('double-clicks and hovers stable locator matches as single page actions', async () => {
    const doubleClickElement = makeElement();
    const hoverElement = makeElement();
    page.evaluateHandle
      .mockResolvedValueOnce(makeHandle(doubleClickElement))
      .mockResolvedValueOnce(makeHandle(hoverElement));

    await expect(
      runtime().page.doubleClick({ role: 'row', name: 'Open item' }, { timeoutMs: 75 })
    ).resolves.toEqual({ url: 'https://example.test/current', title: 'Example' });
    await expect(
      runtime().page.hover({ css: '[data-testid="fare-details"]' }, { timeoutMs: 125 })
    ).resolves.toEqual({ url: 'https://example.test/current', title: 'Example' });

    expect(doubleClickElement.locator.setTimeout).toHaveBeenCalledWith(75);
    expect(doubleClickElement.locator.click).toHaveBeenCalledWith({ count: 2 });
    expect(hoverElement.locator.setTimeout).toHaveBeenCalledWith(125);
    expect(hoverElement.locator.hover).toHaveBeenCalledOnce();
    expect(context.waitForAction).toHaveBeenCalledTimes(2);
    expect(doubleClickElement.dispose).toHaveBeenCalledOnce();
    expect(hoverElement.dispose).toHaveBeenCalledOnce();
  });

  it('does not fall back to a hidden DOM match for an action', async () => {
    const hidden = new FakeElement('button', { 'data-testid': 'hidden-submit' }, 'Submit', [], {
      style: { display: 'none' },
    });
    installFakeDom([hidden], { hitTarget: hidden });
    const actionElements = installPageDomEvaluation(page);

    await expect(
      runtime().page.click({ css: '[data-testid="hidden-submit"]' }, { timeoutMs: 0 })
    ).rejects.toThrow('No matching Browser Skill locator');

    expect(actionElements).toHaveLength(0);
    expect(mocks.takeSnapshot).not.toHaveBeenCalled();
  });

  it('falls through a hidden locator candidate to a fresh actionable DOM candidate', async () => {
    const hidden = new FakeElement(
      'input',
      { 'data-testid': 'stale-search', 'aria-label': 'Search' },
      '',
      [],
      { style: { visibility: 'hidden' } }
    );
    const visible = new FakeElement('input', { 'aria-label': 'Search' });
    installFakeDom([hidden, visible], { hitTarget: visible });
    const actionElements = installPageDomEvaluation(page);

    await runtime().page.fill(
      [{ css: '[data-testid="stale-search"]' }, { role: 'textbox', name: 'Search' }],
      'query',
      { timeoutMs: 0 }
    );

    expect(page.evaluateHandle).toHaveBeenCalledTimes(2);
    expect(actionElements).toHaveLength(1);
    expect(actionElements[0].locator.fill).toHaveBeenCalledWith('query');
  });

  it('scrolls an offscreen target, disposes its handle, and acts on the re-resolved element', async () => {
    const replacement = new FakeElement('button', { 'data-testid': 'continue' }, 'Continue');
    const roots: FakeElement[] = [];
    const offscreen = new FakeElement('button', { 'data-testid': 'continue' }, 'Continue', [], {
      rect: { top: 900 },
      onScrollIntoView: () => {
        offscreen.isConnected = false;
        roots.splice(0, 1, replacement);
      },
    });
    roots.push(offscreen);
    installFakeDom(roots, { hitTarget: replacement });
    const actionElements = installPageDomEvaluation(page);

    await runtime().page.click({ css: '[data-testid="continue"]' }, { timeoutMs: 0 });

    expect(offscreen.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'instant',
      block: 'center',
      inline: 'center',
    });
    expect(page.evaluateHandle).toHaveBeenCalledTimes(2);
    expect(actionElements).toHaveLength(2);
    expect(actionElements[0].locator.click).not.toHaveBeenCalled();
    expect(actionElements[1].locator.click).toHaveBeenCalledWith({ count: 1 });
    expect(actionElements[0].dispose.mock.invocationCallOrder[0]).toBeLessThan(
      page.evaluateHandle.mock.invocationCallOrder[1]
    );
  });

  it('attempts one safe scroll per resolution cycle and reports a still-offscreen target', async () => {
    const offscreen = new FakeElement('button', { id: 'below-fold' }, 'Below fold', [], {
      rect: { top: 900 },
    });
    installFakeDom([offscreen]);
    const actionElements = installPageDomEvaluation(page);

    await expect(runtime().page.click({ css: '#below-fold' }, { timeoutMs: 0 })).rejects.toThrow(
      '"reason":"outside-viewport"'
    );

    expect(offscreen.scrollIntoView).toHaveBeenCalledOnce();
    expect(page.evaluateHandle).toHaveBeenCalledTimes(2);
    expect(actionElements.every((element) => element.locator.click.mock.calls.length === 0)).toBe(
      true
    );
    expect(log).toHaveBeenCalledWith(
      'Browser Skill actionability check failed',
      expect.objectContaining({
        reason: 'outside-viewport',
        rect: expect.objectContaining({ top: 900 }),
        viewport: { width: 1024, height: 768 },
      })
    );
  });

  it('fails before dispatch when an unrelated DOM element owns the hit point', async () => {
    const target = new FakeElement('button', { id: 'submit', 'data-testid': 'submit' }, 'Submit');
    const overlay = new FakeElement('div', { id: 'blocking-overlay', class: 'modal-backdrop' });
    installFakeDom([target, overlay], { hitTarget: overlay });
    const actionElements = installPageDomEvaluation(page);

    await expect(
      runtime().page.click({ css: '[data-testid="submit"]' }, { timeoutMs: 0 })
    ).rejects.toThrow('"reason":"hit-target-mismatch"');

    expect(actionElements).toHaveLength(1);
    expect(actionElements[0].locator.click).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'Browser Skill actionability check failed',
      expect.objectContaining({
        matchCount: 1,
        attached: true,
        visible: true,
        actionable: false,
        reason: 'hit-target-mismatch',
        target: expect.objectContaining({ tag: 'button', id: 'submit', testId: 'submit' }),
        hit: expect.objectContaining({ tag: 'div', id: 'blocking-overlay' }),
      })
    );
    const diagnostic = log.mock.calls.at(-1)?.[1];
    expect(JSON.stringify(diagnostic).toLowerCase()).not.toContain('uid');
  });

  it('never dispatches an action to a disabled target', async () => {
    const disabled = new FakeElement('button', { id: 'disabled-submit' }, 'Submit', [], {
      disabled: true,
    });
    installFakeDom([disabled], { hitTarget: disabled });
    const actionElements = installPageDomEvaluation(page);

    await expect(
      runtime().page.click({ css: '#disabled-submit' }, { timeoutMs: 0 })
    ).rejects.toThrow('"reason":"disabled"');

    expect(actionElements).toHaveLength(1);
    expect(actionElements[0].locator.click).not.toHaveBeenCalled();
  });

  it('allows a descendant DOM hit target and never requests an accessibility snapshot', async () => {
    const label = new FakeElement('span', { class: 'label' }, 'Submit');
    const target = new FakeElement('button', { id: 'submit' }, 'Submit', [label]);
    installFakeDom([target], { hitTarget: label });
    const actionElements = installPageDomEvaluation(page);

    await runtime().page.click({ role: 'button', name: 'Submit' }, { timeoutMs: 0 });

    expect(actionElements).toHaveLength(1);
    expect(actionElements[0].locator.click).toHaveBeenCalledWith({ count: 1 });
    expect(mocks.takeSnapshot).not.toHaveBeenCalled();
  });

  it('re-resolves a detached element before starting a side effect', async () => {
    const stale = makeElement();
    stale.evaluate.mockResolvedValueOnce({
      attached: false,
      visible: false,
      actionable: false,
      reason: 'detached',
      target: { tag: 'button' },
    });
    const fresh = makeElement();
    page.evaluateHandle
      .mockResolvedValueOnce(makeHandle(stale))
      .mockResolvedValueOnce(makeHandle(fresh));
    page.evaluate.mockResolvedValueOnce({ count: 1 });

    await runtime().page.click({ role: 'button', name: 'Continue' }, { timeoutMs: 500 });

    expect(stale.locator.click).not.toHaveBeenCalled();
    expect(fresh.locator.click).toHaveBeenCalledOnce();
    expect(page.evaluateHandle).toHaveBeenCalledTimes(2);
    expect(stale.dispose).toHaveBeenCalledOnce();
    expect(fresh.dispose).toHaveBeenCalledOnce();
  });

  it('resolves scoped text to a current DOM Element rather than a snapshot text node', async () => {
    const text = new FakeElement('span', { class: 'fare-name' }, 'Business class');
    const card = new FakeElement('section', { 'data-fare-card': 'business' }, 'Business class', [
      text,
    ]);
    installFakeDom([card], { hitTarget: text });
    const actionElements = installPageDomEvaluation(page);

    await runtime().page.click(
      {
        text: 'Business class',
        within: { css: '[data-fare-card="business"]' },
      },
      { timeoutMs: 0 }
    );

    expect(actionElements).toHaveLength(1);
    expect(actionElements[0].locator.click).toHaveBeenCalledOnce();
  });

  it('passes only structured extraction data into the page and returns the extracted list', async () => {
    page.evaluate.mockResolvedValueOnce([{ optionId: 'offer-1', summary: 'First option' }]);

    await expect(
      runtime().page.extractList({
        items: { css: '[data-result-item]' },
        fields: {
          optionId: { attribute: 'data-option-id' },
          summary: { text: 'self' },
        },
        limit: 10,
      })
    ).resolves.toEqual([{ optionId: 'offer-1', summary: 'First option' }]);

    const request = page.evaluate.mock.calls[0][1];
    expect(request).toEqual({
      candidates: [{ kind: 'css', css: '[data-result-item]' }],
      fields: {
        optionId: { attribute: 'data-option-id', normalizeWhitespace: true },
        summary: { normalizeWhitespace: true },
      },
      limit: 10,
      state: 'visible',
    });
    expect(JSON.stringify(request)).not.toContain('uid');
  });

  it('extracts every repeated item for non-CSS locators instead of only the first match', async () => {
    const first = new FakeElement(
      'div',
      { role: 'option', 'data-option-id': 'offer-1' },
      'First option'
    );
    const second = new FakeElement(
      'div',
      { role: 'option', 'data-option-id': 'offer-2' },
      'Second option'
    );
    installFakeDom([first, second]);
    page.evaluate.mockImplementationOnce(
      async (fn: (request: unknown) => unknown, request: unknown) => fn(request)
    );

    await expect(
      runtime().page.extractList({
        items: { role: 'option', name: /option/i },
        fields: {
          optionId: { attribute: 'data-option-id' },
          summary: { text: 'self' },
        },
      })
    ).resolves.toEqual([
      { optionId: 'offer-1', summary: 'First option' },
      { optionId: 'offer-2', summary: 'Second option' },
    ]);
  });

  it('excludes hidden list items by default and includes them only for explicit attached reads', async () => {
    const visible = new FakeElement(
      'div',
      { class: 'result', 'data-id': 'visible' },
      'Visible result'
    );
    const hidden = new FakeElement(
      'div',
      { class: 'result', 'data-id': 'hidden' },
      'Hidden result',
      [],
      { style: { display: 'none' } }
    );
    installFakeDom([visible, hidden]);
    installPageDomEvaluation(page);
    const request = {
      items: { css: '.result' } as const,
      fields: {
        id: { attribute: 'data-id' },
        label: { text: 'self' as const },
      },
    };

    await expect(runtime().page.extractList(request)).resolves.toEqual([
      { id: 'visible', label: 'Visible result' },
    ]);
    await expect(runtime().page.extractList({ ...request, state: 'attached' })).resolves.toEqual([
      { id: 'visible', label: 'Visible result' },
      { id: 'hidden', label: 'Hidden result' },
    ]);
  });

  it('applies the list extraction state to nested field locators', async () => {
    const hiddenField = new FakeElement('span', { class: 'secondary-label' }, 'Hidden detail', [], {
      style: { display: 'none' },
    });
    const item = new FakeElement('div', { class: 'result' }, '', [hiddenField]);
    installFakeDom([item]);
    installPageDomEvaluation(page);
    const request = {
      items: { css: '.result' } as const,
      fields: {
        secondaryLabel: { locator: { css: '.secondary-label' } },
      },
    };

    await expect(runtime().page.extractList(request)).resolves.toEqual([{ secondaryLabel: null }]);
    await expect(runtime().page.extractList({ ...request, state: 'attached' })).resolves.toEqual([
      { secondaryLabel: 'Hidden detail' },
    ]);
  });

  it('waits on live values, attributes, counts, and all DOM element states', async () => {
    const input = new FakeElement('input', {
      id: 'query',
      value: 'stale-attribute',
      'data-state': 'ready',
    });
    input.value = 'live-value';
    const first = new FakeElement('div', { class: 'result' }, 'First');
    const second = new FakeElement('div', { class: 'result' }, 'Second');
    const hidden = new FakeElement('div', { id: 'hidden-panel' }, 'Hidden', [], {
      style: { visibility: 'hidden' },
    });
    installFakeDom([input, first, second, hidden], { hitTarget: input });
    installPageDomEvaluation(page);
    const immediate = { timeoutMs: 0, pollIntervalMs: 1 } as const;

    await expect(
      runtime().page.waitFor({ locator: { css: '#query' }, value: 'live-value' }, immediate)
    ).resolves.toMatchObject({ url: 'https://example.test/current' });
    await expect(
      runtime().page.waitFor(
        {
          locator: { css: '#query' },
          attribute: 'data-state',
          matches: 'ready',
        },
        immediate
      )
    ).resolves.toMatchObject({ title: 'Example' });
    await expect(
      runtime().page.waitFor(
        {
          locator: { css: '.result' },
          count: { min: 2, max: 2 },
        },
        immediate
      )
    ).resolves.toBeDefined();
    await expect(
      runtime().page.waitFor(
        {
          locator: { css: '#hidden-panel' },
          state: 'attached',
        },
        immediate
      )
    ).resolves.toBeDefined();
    await expect(
      runtime().page.waitFor(
        {
          locator: { css: '#hidden-panel' },
          state: 'hidden',
        },
        immediate
      )
    ).resolves.toBeDefined();
    await expect(
      runtime().page.waitFor(
        {
          locator: { css: '#query' },
          state: 'actionable',
        },
        immediate
      )
    ).resolves.toBeDefined();
    await expect(
      runtime().page.waitFor(
        {
          locator: { css: '#hidden-panel' },
        },
        immediate
      )
    ).rejects.toThrow('timed out after 0ms');
  });

  it('matches a missing DOM attribute without confusing it with a missing element', async () => {
    const target = new FakeElement('div', { id: 'target' });
    installFakeDom([target]);
    installPageDomEvaluation(page);

    await expect(
      runtime().page.waitFor(
        {
          locator: { css: '#target' },
          attribute: 'data-optional',
          matches: null,
        },
        { timeoutMs: 0 }
      )
    ).resolves.toBeDefined();
    await expect(
      runtime().page.waitFor(
        {
          locator: { css: '#missing' },
          attribute: 'data-optional',
          matches: null,
        },
        { timeoutMs: 0 }
      )
    ).rejects.toThrow('timed out after 0ms');
  });

  it('waits for page events from key presses and observes the newly selected page', async () => {
    const browser = runtime();
    const nextPage = makePage();
    nextPage.url.mockReturnValue('https://example.test/next');
    nextPage.title.mockResolvedValue('Next');
    context.waitForAction.mockImplementationOnce(
      async (action: () => Promise<unknown>) => {
        await action();
        context.getSelectedPage.mockReturnValue(nextPage);
      }
    );

    await expect(browser.page.press('Enter')).resolves.toEqual({
      url: 'https://example.test/next',
      title: 'Next',
    });
    expect(page.keyboard.press).toHaveBeenCalledWith('Enter');
    expect(context.waitForAction).toHaveBeenCalledOnce();
    expect(mocks.pressKey).not.toHaveBeenCalled();
    await expect(browser.page.press('   ')).rejects.toThrow('press key cannot be empty');
  });

  it('honors cancellation before touching BrowserManager and reports wait timeouts', async () => {
    controller.abort();
    const browser = runtime();
    await expect(browser.page.currentPage()).rejects.toThrow('Browser Skill call was cancelled');
    await expect(browser.listPages()).rejects.toThrow('Browser Skill call was cancelled');
    expect(mocks.runExclusive).not.toHaveBeenCalled();

    controller = new AbortController();
    await expect(
      runtime().page.waitFor(
        { url: '/never-matches' },
        {
          timeoutMs: 0,
          pollIntervalMs: 1,
        }
      )
    ).rejects.toThrow('Browser Skill waitFor timed out after 0ms');
  });

  it('does not sleep a full poll interval after a wait deadline', async () => {
    const startedAt = Date.now();

    await expect(
      runtime().page.waitFor(
        { url: '/never-matches' },
        {
          timeoutMs: 5,
          pollIntervalMs: 5_000,
        }
      )
    ).rejects.toThrow('timed out after 5ms');

    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('keeps the checked-in Builder API Reference synchronized with the public SDK declarations', async () => {
    const projectRoot = path.resolve(import.meta.dirname, '../../../../..');

    await expect(
      execFileAsync(
        process.execPath,
        ['scripts/generate-browser-skill-sdk-reference.mjs', '--check'],
        { cwd: projectRoot }
      )
    ).resolves.toMatchObject({ stderr: '' });
  });

  it('documents extraction absence separately from action and wait failures', () => {
    expect(BROWSER_SKILL_SDK_REFERENCE).toContain(
      'listPages(): Promise<readonly BrowserPageInfo[]>'
    );
    expect(BROWSER_SKILL_SDK_REFERENCE).toContain(
      'selectPage(pageIdx: number): Promise<BrowserPageObservation>'
    );
    expect(BROWSER_SKILL_SDK_REFERENCE).toContain(
      'Page indices belong to the latest listing and must not be persisted as business identifiers'
    );
    expect(BROWSER_SKILL_SDK_REFERENCE).toContain(
      'Use `doubleClick` only when the real website control requires a double-click'
    );
    expect(BROWSER_SKILL_SDK_REFERENCE).toContain(
      'Use `hover` when moving the pointer over an element is required to reveal or update content'
    );
    expect(BROWSER_SKILL_SDK_REFERENCE).toContain(
      'follow it with `waitFor` before extracting content or taking the next action'
    );
    expect(BROWSER_SKILL_SDK_REFERENCE).toContain(
      '`extractText` returns `null` when no element matches after its bounded wait'
    );
    expect(BROWSER_SKILL_SDK_REFERENCE).toContain(
      '`extractList` returns `[]` when no item matches'
    );
    expect(BROWSER_SKILL_SDK_REFERENCE).toContain("Both default to `state: 'visible'`");
    expect(BROWSER_SKILL_SDK_REFERENCE).toContain(
      'selected state governs both item locators and nested field locators'
    );
    expect(BROWSER_SKILL_SDK_REFERENCE).toContain(
      'a hidden descendant field returns `null` under the default visible extraction'
    );
    expect(BROWSER_SKILL_SDK_REFERENCE).toContain(
      'Action methods and `waitFor` throw on invalid input'
    );
    expect(BROWSER_SKILL_SDK_REFERENCE).not.toContain(
      'Methods throw on invalid input, cancellation, missing elements, or timeout'
    );
  });
});

function makePage() {
  return {
    url: vi.fn(() => 'https://example.test/current'),
    title: vi.fn(async () => 'Example'),
    bringToFront: vi.fn(async () => undefined),
    keyboard: { press: vi.fn(async () => undefined) },
    evaluateHandle: vi.fn(),
    evaluate: vi.fn(),
  };
}

function makeHandle(element: ReturnType<typeof makeElement> | null) {
  return {
    asElement: vi.fn(() => element),
    dispose: vi.fn(async () => undefined),
  };
}

function makeElement(domElement?: FakeElement) {
  const locator = {
    setTimeout: vi.fn(),
    click: vi.fn(async () => undefined),
    hover: vi.fn(async () => undefined),
    fill: vi.fn(async (_value: string) => undefined),
  };
  locator.setTimeout.mockReturnValue(locator);
  return {
    locator,
    asLocator: vi.fn(() => locator),
    select: vi.fn(async (value: string) => [value]),
    evaluate: vi.fn(
      async (fn: (element: FakeElement, request?: unknown) => unknown, request?: unknown) => {
        if (domElement) return fn(domElement, request);
        if (fn.name === 'inspectElementActionability') {
          return {
            attached: true,
            visible: true,
            actionable: true,
            target: { tag: 'button' },
            hit: { tag: 'button' },
          };
        }
        return 'text';
      }
    ),
    dispose: vi.fn(async () => undefined),
  };
}

class FakeElement {
  readonly children: FakeElement[];
  readonly tagName: string;
  readonly textContent: string;
  readonly computedStyle: {
    display: string;
    visibility: string;
    opacity: string;
    pointerEvents: string;
  };
  value: string | undefined;
  disabled: boolean;
  inert: boolean;
  isConnected: boolean;
  readonly scrollIntoView: ReturnType<typeof vi.fn>;
  parent: FakeElement | undefined;
  private readonly rect: { left: number; top: number; width: number; height: number };

  constructor(
    tagName: string,
    private readonly attributes: Record<string, string> = {},
    textContent = '',
    children: FakeElement[] = [],
    options: {
      style?: Partial<FakeElement['computedStyle']>;
      rect?: Partial<FakeElement['rect']>;
      connected?: boolean;
      disabled?: boolean;
      inert?: boolean;
      onScrollIntoView?: () => void;
    } = {}
  ) {
    this.tagName = tagName.toUpperCase();
    this.textContent = textContent;
    this.value = attributes.value;
    this.children = children;
    this.computedStyle = {
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      pointerEvents: 'auto',
      ...options.style,
    };
    this.rect = { left: 10, top: 10, width: 100, height: 20, ...options.rect };
    this.isConnected = options.connected !== false;
    this.disabled = options.disabled === true;
    this.inert = options.inert === true;
    this.scrollIntoView = vi.fn(() => options.onScrollIntoView?.());
    for (const child of children) child.parent = this;
  }

  get parentElement(): FakeElement | null {
    return this.parent ?? null;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  hasAttribute(name: string): boolean {
    return Object.hasOwn(this.attributes, name);
  }

  matches(selector: string): boolean {
    if (selector === '*') return true;
    if (selector === 'label') return this.tagName === 'LABEL';
    if (selector.startsWith('.')) {
      return (this.attributes.class ?? '').split(/\s+/).includes(selector.slice(1));
    }
    if (selector.startsWith('#')) return this.attributes.id === selector.slice(1);
    const attribute = /^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/u.exec(selector);
    if (attribute) {
      const value = this.getAttribute(attribute[1]);
      return value !== null && (attribute[2] === undefined || value === attribute[2]);
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((element) => element.matches(selector));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) return this;
    let current = this.parent;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parent;
    }
    return null;
  }

  contains(candidate: FakeElement): boolean {
    return candidate === this || this.descendants().includes(candidate);
  }

  getBoundingClientRect(): {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  } {
    return {
      ...this.rect,
      right: this.rect.left + this.rect.width,
      bottom: this.rect.top + this.rect.height,
    };
  }

  private descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

class FakeLabelElement extends FakeElement {
  readonly control: FakeElement | null = null;
  readonly htmlFor = '';
}

function installFakeDom(
  elements: FakeElement[],
  options: { hitTarget?: FakeElement | null } = {}
): void {
  const all = (): FakeElement[] =>
    elements.flatMap((element) => [element, ...element.querySelectorAll('*')]);
  vi.stubGlobal('Element', FakeElement);
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('HTMLInputElement', FakeElement);
  vi.stubGlobal('HTMLLabelElement', FakeLabelElement);
  vi.stubGlobal('document', {
    querySelectorAll: (selector: string) => all().filter((element) => element.matches(selector)),
    getElementById: (id: string) =>
      all().find((element) => element.getAttribute('id') === id) ?? null,
    elementFromPoint: () => options.hitTarget ?? null,
    documentElement: { clientWidth: 1024, clientHeight: 768 },
  });
  vi.stubGlobal('window', {
    getComputedStyle: (element: FakeElement) => element.computedStyle,
    innerWidth: 1024,
    innerHeight: 768,
    requestAnimationFrame: (callback: (timestamp: number) => void) => {
      callback(0);
      return 1;
    },
  });
}

function installPageDomEvaluation(page: ReturnType<typeof makePage>) {
  const elements: ReturnType<typeof makeElement>[] = [];
  page.evaluate.mockImplementation(async (fn: (request: unknown) => unknown, request: unknown) =>
    fn(request)
  );
  page.evaluateHandle.mockImplementation(
    async (
      fn: (request: unknown) => FakeElement | Promise<FakeElement | null> | null,
      request: unknown
    ) => {
      const domElement = await fn(request);
      if (!domElement) return makeHandle(null);
      const element = makeElement(domElement);
      elements.push(element);
      return makeHandle(element);
    }
  );
  return elements;
}
