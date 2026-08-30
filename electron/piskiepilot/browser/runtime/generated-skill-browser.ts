import {
  BrowserManager,
  type ConnectedBrowserSession,
} from '../core/browser/browser-manager.js';
import { BrowserOperations } from '../core/browser/browser-operations.js';

type BrowserSession = ConnectedBrowserSession['automation'];
type BrowserPage = ReturnType<BrowserSession['getSelectedPage']>;
type BrowserElement = Awaited<ReturnType<BrowserPage['$']>> & {};

export type BrowserSkillText = string | RegExp;

export type BrowserSkillElementState = 'attached' | 'visible' | 'actionable' | 'hidden';

export type BrowserSkillLocator =
  | Readonly<{ css: string }>
  | Readonly<{ role: string; name?: BrowserSkillText }>
  | Readonly<{ label: BrowserSkillText }>
  | Readonly<{ placeholder: BrowserSkillText }>
  | Readonly<{ text: BrowserSkillText; within?: BrowserSkillLocator }>;

export interface BrowserPageObservation {
  url: string;
  title: string;
}

export interface BrowserPageInfo extends BrowserPageObservation {
  pageIdx: number;
  selected: boolean;
}

export interface BrowserNavigateOptions {
  timeoutMs?: number;
}

export interface BrowserActionOptions {
  timeoutMs?: number;
}

export type BrowserWaitCondition =
  | Readonly<{
      locator: BrowserSkillLocator | readonly BrowserSkillLocator[];
      state?: BrowserSkillElementState;
    }>
  | Readonly<{
      locator: BrowserSkillLocator | readonly BrowserSkillLocator[];
      value: BrowserSkillText;
    }>
  | Readonly<{
      locator: BrowserSkillLocator | readonly BrowserSkillLocator[];
      attribute: string;
      matches: BrowserSkillText | null;
    }>
  | Readonly<{
      locator: BrowserSkillLocator | readonly BrowserSkillLocator[];
      count: number | Readonly<{ min?: number; max?: number }>;
      state?: Exclude<BrowserSkillElementState, 'hidden'>;
    }>
  | Readonly<{ text: BrowserSkillText }>
  | Readonly<{ url: BrowserSkillText }>;

export interface BrowserWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface BrowserTextExtraction {
  locator: BrowserSkillLocator | readonly BrowserSkillLocator[];
  attribute?: string;
  /** Defaults to visible extraction. */
  state?: 'attached' | 'visible';
  normalizeWhitespace?: boolean;
}

export type BrowserListField = Readonly<{
  locator?: BrowserSkillLocator;
  text?: 'self';
  attribute?: string;
  normalizeWhitespace?: boolean;
}>;

export interface BrowserListExtraction {
  items: BrowserSkillLocator | readonly BrowserSkillLocator[];
  fields: Readonly<Record<string, BrowserListField>>;
  /** Defaults to visible and also governs nested field locators. */
  state?: 'attached' | 'visible';
  limit?: number;
}

export interface GeneratedSkillPage {
  /** Navigate the selected page to an HTTP(S) URL and return its observable identity. */
  navigate(url: string, options?: BrowserNavigateOptions): Promise<BrowserPageObservation>;
  /** Read the selected page URL and title without mutating it. */
  currentPage(): Promise<BrowserPageObservation>;
  /** Click the first matching stable locator option. */
  click(
    locator: BrowserSkillLocator | readonly BrowserSkillLocator[],
    options?: BrowserActionOptions
  ): Promise<BrowserPageObservation>;
  /** Double-click the first matching stable locator option. */
  doubleClick(
    locator: BrowserSkillLocator | readonly BrowserSkillLocator[],
    options?: BrowserActionOptions
  ): Promise<BrowserPageObservation>;
  /** Hover over the first matching stable locator option. */
  hover(
    locator: BrowserSkillLocator | readonly BrowserSkillLocator[],
    options?: BrowserActionOptions
  ): Promise<BrowserPageObservation>;
  /** Replace the value of the first matching input, textarea, or contenteditable. */
  fill(
    locator: BrowserSkillLocator | readonly BrowserSkillLocator[],
    value: string,
    options?: BrowserActionOptions
  ): Promise<BrowserPageObservation>;
  /** Select one option value on the first matching native select element. */
  select(
    locator: BrowserSkillLocator | readonly BrowserSkillLocator[],
    value: string,
    options?: BrowserActionOptions
  ): Promise<BrowserPageObservation>;
  /** Send a Puppeteer-compatible key or key combination to the selected page. */
  press(key: string): Promise<BrowserPageObservation>;
  /** Wait until a structured locator, text, or URL condition matches. */
  waitFor(
    condition: BrowserWaitCondition,
    options?: BrowserWaitOptions
  ): Promise<BrowserPageObservation>;
  /** Extract normalized text or one attribute from the first matching element. */
  extractText(request: BrowserTextExtraction): Promise<string | null>;
  /** Extract structured fields from a repeated list without accepting page code. */
  extractList(request: BrowserListExtraction): Promise<readonly Record<string, string | null>[]>;
}

export interface GeneratedBrowserSkillRuntime {
  readonly page: GeneratedSkillPage;
  /** Refresh and list all open browser pages/tabs using browser-compatible indices. */
  listPages(): Promise<readonly BrowserPageInfo[]>;
  /** Select one page/tab for subsequent page operations. Use an index from the latest listPages call. */
  selectPage(pageIdx: number): Promise<BrowserPageObservation>;
}

export interface GeneratedSkillBrowserBinding {
  browserId: string;
  signal: AbortSignal;
  log(message: string, data?: unknown): void;
  notifyPageOpen(): void;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 200;

type SerializableText =
  | Readonly<{ kind: 'literal'; value: string }>
  | Readonly<{ kind: 'regexp'; source: string; flags: string }>;

type SerializableLocator =
  | Readonly<{ kind: 'css'; css: string }>
  | Readonly<{ kind: 'role'; role: string; name?: SerializableText }>
  | Readonly<{ kind: 'label'; label: SerializableText }>
  | Readonly<{ kind: 'placeholder'; placeholder: SerializableText }>
  | Readonly<{ kind: 'text'; text: SerializableText; within?: SerializableLocator }>;

type SerializableListField = Readonly<{
  locator?: SerializableLocator;
  attribute?: string;
  normalizeWhitespace: boolean;
}>;

type BrowserElementRequirement = 'attached' | 'visible' | 'actionable';

type SerializableLocatorQuery = Readonly<{
  candidates: readonly SerializableLocator[];
  state: Exclude<BrowserSkillElementState, 'hidden'>;
  read?: Readonly<{ kind: 'value' }> | Readonly<{ kind: 'attribute'; name: string }>;
}>;

type LocatorQueryResult = Readonly<{
  count: number;
  value?: string | null;
}>;

type ElementSummary = Readonly<{
  tag: string;
  id?: string;
  role?: string;
  testId?: string;
  className?: string;
}>;

type ElementRectangle = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}>;

type ViewportSummary = Readonly<{
  width: number;
  height: number;
}>;

type ActionabilityReport = Readonly<{
  attached: boolean;
  visible: boolean;
  actionable: boolean;
  reason?: string;
  target?: ElementSummary;
  hit?: ElementSummary;
  rect?: ElementRectangle;
  viewport?: ViewportSummary;
}>;

type ResolvedBrowserElement = Readonly<{
  element: BrowserElement | null;
  report?: ActionabilityReport;
}>;

type ActionabilityDiagnostic = Readonly<{
  matchCount: number;
  attached: boolean;
  visible: boolean;
  actionable: boolean;
  reason: string;
  target?: ElementSummary;
  hit?: ElementSummary;
  rect?: ElementRectangle;
  viewport?: ViewportSummary;
}>;

type ElementUseOptions = Readonly<{
  requirement: BrowserElementRequirement;
  nullable?: boolean;
  sideEffect?: boolean;
}>;

class RetryableElementResolutionError extends Error {}

export function createGeneratedBrowserSkillRuntime(
  binding: GeneratedSkillBrowserBinding
): GeneratedBrowserSkillRuntime {
  const facade = new GeneratedSkillPageFacade(binding);
  const page: GeneratedSkillPage = Object.freeze({
    navigate: facade.navigate.bind(facade),
    currentPage: facade.currentPage.bind(facade),
    click: facade.click.bind(facade),
    doubleClick: facade.doubleClick.bind(facade),
    hover: facade.hover.bind(facade),
    fill: facade.fill.bind(facade),
    select: facade.select.bind(facade),
    press: facade.press.bind(facade),
    waitFor: facade.waitFor.bind(facade),
    extractText: facade.extractText.bind(facade),
    extractList: facade.extractList.bind(facade),
  });
  return Object.freeze({
    page,
    listPages: facade.listPages.bind(facade),
    selectPage: facade.selectPage.bind(facade),
  });
}

class GeneratedSkillPageFacade implements GeneratedSkillPage {
  readonly #binding: GeneratedSkillBrowserBinding;

  constructor(binding: GeneratedSkillBrowserBinding) {
    this.#binding = binding;
  }

  listPages(): Promise<readonly BrowserPageInfo[]> {
    return this.#withLockedBrowser(async (context) => {
      const pages = await context.listPages();
      const selectedPageIdx = context.getSelectedPageIndex();
      return Promise.all(
        pages.map(async ({ page }, pageIdx) => ({
          pageIdx,
          selected: pageIdx === selectedPageIdx,
          ...(await observe(page)),
        }))
      );
    });
  }

  async selectPage(pageIdx: number): Promise<BrowserPageObservation> {
    validatePageIdx(pageIdx);
    return this.#withLockedBrowser(async (context) => {
      const page = await context.selectPageByIndex(pageIdx);
      return observe(page);
    });
  }

  async navigate(
    url: string,
    options: BrowserNavigateOptions = {}
  ): Promise<BrowserPageObservation> {
    this.#assertActive();
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Browser Skill navigation only supports HTTP(S): ${parsed.protocol}`);
    }
    this.#binding.log('Browser Skill navigate', { url: parsed.href });
    const result = await BrowserOperations.navigate({
      browserId: this.#binding.browserId,
      url: parsed.href,
      timeout: timeout(options.timeoutMs),
      signal: this.#binding.signal,
    });
    this.#binding.notifyPageOpen();
    return { url: result.url, title: result.title };
  }
  currentPage(): Promise<BrowserPageObservation> {
    return this.#withSelectedPage(async (page) => observe(page));
  }

  click(
    locator: BrowserSkillLocator | readonly BrowserSkillLocator[],
    options: BrowserActionOptions = {}
  ): Promise<BrowserPageObservation> {
    return this.#click(locator, 1, options);
  }

  doubleClick(
    locator: BrowserSkillLocator | readonly BrowserSkillLocator[],
    options: BrowserActionOptions = {}
  ): Promise<BrowserPageObservation> {
    return this.#click(locator, 2, options);
  }

  hover(
    locator: BrowserSkillLocator | readonly BrowserSkillLocator[],
    options: BrowserActionOptions = {}
  ): Promise<BrowserPageObservation> {
    return this.#withElement(
      locator,
      options.timeoutMs,
      { requirement: 'actionable', sideEffect: true },
      async (_page, element, context) => {
        await context.waitForAction(() =>
          element.asLocator().setTimeout(timeout(options.timeoutMs)).hover()
        );
        return observe(context.getSelectedPage());
      }
    );
  }

  fill(
    locator: BrowserSkillLocator | readonly BrowserSkillLocator[],
    value: string,
    options: BrowserActionOptions = {}
  ): Promise<BrowserPageObservation> {
    return this.#withElement(
      locator,
      options.timeoutMs,
      { requirement: 'actionable', sideEffect: true },
      async (_page, element, context) => {
        await context.waitForAction(() =>
          element.asLocator().setTimeout(timeout(options.timeoutMs)).fill(value)
        );
        return observe(context.getSelectedPage());
      }
    );
  }

  select(
    locator: BrowserSkillLocator | readonly BrowserSkillLocator[],
    value: string,
    options: BrowserActionOptions = {}
  ): Promise<BrowserPageObservation> {
    return this.#withElement(
      locator,
      options.timeoutMs,
      { requirement: 'actionable', sideEffect: true },
      async (_page, element, context) => {
        await context.waitForAction(async () => {
          const selected = await element.select(value);
          if (selected.length === 0) {
            throw new Error(`Select option was not found: ${JSON.stringify(value)}`);
          }
        });
        return observe(context.getSelectedPage());
      }
    );
  }

  async press(key: string): Promise<BrowserPageObservation> {
    if (!key.trim()) throw new Error('Browser Skill press key cannot be empty');
    return this.#withLockedContext(async (page, context) => {
      type PuppeteerKey = Parameters<typeof page.keyboard.press>[0];
      await context.waitForAction(() => page.keyboard.press(key as PuppeteerKey));
      return observe(context.getSelectedPage());
    });
  }
  async waitFor(
    condition: BrowserWaitCondition,
    options: BrowserWaitOptions = {}
  ): Promise<BrowserPageObservation> {
    const locatorWait = 'locator' in condition ? prepareLocatorWait(condition) : undefined;
    const deadline = Date.now() + timeout(options.timeoutMs);
    const interval = positive(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 'pollIntervalMs');
    let lastError: unknown;
    while (Date.now() <= deadline) {
      this.#assertActive();
      try {
        if (locatorWait) {
          const result = await this.#withSelectedPage((page) =>
            page.evaluate(queryPageLocator, locatorWait.query)
          );
          if (locatorWait.matches(result)) return this.currentPage();
        } else if ('text' in condition) {
          const found = await this.#withSelectedPage((page) =>
            page.evaluate(matchesPageText, serializeText(condition.text))
          );
          if (found) return this.currentPage();
        } else if ('url' in condition) {
          const observation = await this.currentPage();
          if (matchesText(observation.url, condition.url)) return observation;
        }
      } catch (error) {
        lastError = error;
      }
      if (!(await pollDelay(deadline, interval, this.#binding.signal))) break;
    }
    const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
    throw new Error(
      `Browser Skill waitFor timed out after ${timeout(options.timeoutMs)}ms.${detail}`
    );
  }

  extractText(request: BrowserTextExtraction): Promise<string | null> {
    validateAttribute(request.attribute);
    const requirement = extractionState(request.state);
    return this.#withElement(
      request.locator,
      DEFAULT_TIMEOUT_MS,
      { requirement, nullable: true },
      async (_page, element) =>
        element.evaluate(extractElementValue, {
          attribute: request.attribute,
          normalizeWhitespace: request.normalizeWhitespace !== false,
        })
    );
  }

  extractList(request: BrowserListExtraction): Promise<readonly Record<string, string | null>[]> {
    const candidates = locatorCandidates(request.items).map(serializeLocator);
    const fields = Object.fromEntries(
      Object.entries(request.fields).map(([name, field]) => {
        validateAttribute(field.attribute);
        return [
          name,
          {
            ...(field.locator ? { locator: serializeLocator(field.locator) } : {}),
            ...(field.attribute ? { attribute: field.attribute } : {}),
            normalizeWhitespace: field.normalizeWhitespace !== false,
          } satisfies SerializableListField,
        ];
      })
    );
    const limit = request.limit === undefined ? 100 : positive(request.limit, 100, 'limit');
    const state = extractionState(request.state);
    return this.#withSelectedPage((page) =>
      page.evaluate(extractPageList, { candidates, fields, limit, state })
    );
  }

  async #withElement<T>(
    locator: BrowserSkillLocator | readonly BrowserSkillLocator[],
    timeoutMs: number | undefined,
    options: ElementUseOptions,
    action: (
      page: BrowserPage,
      element: BrowserElement,
      context: BrowserSession
    ) => Promise<T>
  ): Promise<T> {
    const candidates = locatorCandidates(locator);
    const serializedCandidates = candidates.map(serializeLocator);
    const deadline = Date.now() + timeout(timeoutMs);
    let lastError: unknown;
    let actionabilityDiagnostic: ActionabilityDiagnostic | undefined;
    let sideEffectStarted = false;
    while (Date.now() <= deadline) {
      this.#assertActive();
      try {
        const result = await this.#withLockedContext(async (page, context) => {
          candidateLoop: for (const candidate of serializedCandidates) {
            const resolved = await resolveElement(
              page,
              candidate,
              options.requirement === 'actionable' ? 'visible' : options.requirement
            );
            let element = resolved.element;
            if (!element) continue;
            try {
              if (options.requirement === 'actionable') {
                for (let inspectionAttempt = 0; inspectionAttempt < 2; inspectionAttempt += 1) {
                  let report: ActionabilityReport;
                  try {
                    report = await element.evaluate(inspectElementActionability);
                  } catch (error) {
                    lastError = new RetryableElementResolutionError(
                      error instanceof Error ? error.message : String(error)
                    );
                    continue candidateLoop;
                  }
                  if (report.actionable) break;

                  const inspected = await page.evaluate(queryPageLocator, {
                    candidates: [candidate],
                    state: 'attached',
                  } satisfies SerializableLocatorQuery);
                  actionabilityDiagnostic = {
                    matchCount: inspected.count,
                    attached: report.attached,
                    visible: report.visible,
                    actionable: false,
                    reason: report.reason ?? 'DOM target is not actionable',
                    ...(report.target ? { target: report.target } : {}),
                    ...(report.hit ? { hit: report.hit } : {}),
                    ...(report.rect ? { rect: report.rect } : {}),
                    ...(report.viewport ? { viewport: report.viewport } : {}),
                  };
                  lastError = new RetryableElementResolutionError(
                    report.reason ?? 'DOM target is not actionable'
                  );

                  if (report.reason !== 'outside-viewport' || inspectionAttempt > 0) {
                    continue candidateLoop;
                  }

                  let scrollSucceeded = false;
                  try {
                    scrollSucceeded = await element.evaluate(scrollElementIntoView);
                  } catch (error) {
                    lastError = new RetryableElementResolutionError(
                      error instanceof Error ? error.message : String(error)
                    );
                  }

                  // Scrolling may virtualize or replace the node, so never act through this handle.
                  const scrolledElement = element;
                  element = null;
                  await scrolledElement.dispose();
                  if (!scrollSucceeded) continue candidateLoop;

                  const refreshed = await resolveElement(page, candidate, 'visible');
                  element = refreshed.element;
                  if (!element) {
                    lastError = new RetryableElementResolutionError(
                      'DOM target disappeared after scrolling into view'
                    );
                    continue candidateLoop;
                  }
                }
              }
              if (options.sideEffect) sideEffectStarted = true;
              return { found: true as const, value: await action(page, element, context) };
            } finally {
              if (element) await element.dispose();
            }
          }
          return { found: false as const };
        });
        if (result.found) return result.value;
      } catch (error) {
        // Candidate recovery is safe only until an actual page side effect starts.
        if (sideEffectStarted) throw error;
        lastError = error;
      }
      if (!(await pollDelay(deadline, DEFAULT_POLL_INTERVAL_MS, this.#binding.signal))) break;
    }
    if (options.nullable) {
      if (lastError) throw lastError;
      return null as T;
    }
    if (actionabilityDiagnostic) {
      this.#binding.log('Browser Skill actionability check failed', actionabilityDiagnostic);
      throw new Error(
        `Browser Skill action requires an actionable DOM target: ${JSON.stringify(actionabilityDiagnostic)}`
      );
    }
    const rendered = candidates.map(renderLocator).join(' OR ');
    const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
    throw new Error(`No matching Browser Skill locator: ${rendered}.${detail}`);
  }

  #withSelectedPage<T>(action: (page: BrowserPage) => Promise<T>): Promise<T> {
    return this.#withLockedContext((page) => action(page));
  }

  #click(
    locator: BrowserSkillLocator | readonly BrowserSkillLocator[],
    count: 1 | 2,
    options: BrowserActionOptions
  ): Promise<BrowserPageObservation> {
    return this.#withElement(
      locator,
      options.timeoutMs,
      { requirement: 'actionable', sideEffect: true },
      async (_page, element, context) => {
        await context.waitForAction(() =>
          element.asLocator().setTimeout(timeout(options.timeoutMs)).click({ count })
        );
        return observe(context.getSelectedPage());
      }
    );
  }

  async #withLockedContext<T>(
    action: (page: BrowserPage, context: BrowserSession) => Promise<T>
  ): Promise<T> {
    this.#assertActive();
    return BrowserManager.runExclusive(
      this.#binding.browserId,
      async ({ automation }) => {
        this.#assertActive();
        const value = await action(automation.getSelectedPage(), automation);
        this.#assertActive();
        return value;
      },
      this.#binding.signal
    );
  }

  async #withLockedBrowser<T>(action: (context: BrowserSession) => Promise<T>): Promise<T> {
    this.#assertActive();
    return BrowserManager.runExclusive(
      this.#binding.browserId,
      async ({ automation }) => {
        this.#assertActive();
        const value = await action(automation);
        this.#assertActive();
        return value;
      },
      this.#binding.signal
    );
  }

  #assertActive(): void {
    if (this.#binding.signal.aborted) {
      throw new Error('Browser Skill call was cancelled', {
        cause: this.#binding.signal.reason,
      });
    }
  }
}

async function observe(page: BrowserPage): Promise<BrowserPageObservation> {
  return { url: page.url(), title: await page.title() };
}

function validatePageIdx(pageIdx: number): void {
  if (!Number.isInteger(pageIdx) || pageIdx < 0) {
    throw new Error('Browser Skill pageIdx must be a non-negative integer');
  }
}

function locatorCandidates(
  locator: BrowserSkillLocator | readonly BrowserSkillLocator[]
): readonly BrowserSkillLocator[] {
  const candidates = Array.isArray(locator) ? locator : [locator];
  if (candidates.length === 0) throw new Error('At least one locator candidate is required');
  return candidates;
}

type LocatorWaitCondition = Extract<BrowserWaitCondition, Readonly<{ locator: unknown }>>;

type PreparedLocatorWait = Readonly<{
  query: SerializableLocatorQuery;
  matches(result: LocatorQueryResult): boolean;
}>;

function prepareLocatorWait(condition: LocatorWaitCondition): PreparedLocatorWait {
  const candidates = locatorCandidates(condition.locator).map(serializeLocator);
  if ('value' in condition) {
    return {
      query: { candidates, state: 'visible', read: { kind: 'value' } },
      matches: (result) =>
        result.count > 0 &&
        result.value !== null &&
        result.value !== undefined &&
        matchesText(result.value, condition.value),
    };
  }
  if ('attribute' in condition) {
    validateAttribute(condition.attribute);
    return {
      query: {
        candidates,
        state: 'visible',
        read: { kind: 'attribute', name: condition.attribute },
      },
      matches: (result) =>
        result.count > 0 &&
        (condition.matches === null
          ? result.value === null
          : result.value !== null &&
            result.value !== undefined &&
            matchesText(result.value, condition.matches)),
    };
  }
  if ('count' in condition) {
    const expected = validateCountExpectation(condition.count);
    const state = elementState(condition.state, 'visible');
    if (state === 'hidden') {
      throw new Error('Browser Skill count waits do not support the hidden state');
    }
    return {
      query: { candidates, state },
      matches: (result) => countMatches(result.count, expected),
    };
  }
  const state = elementState(condition.state, 'visible');
  if (state === 'hidden') {
    return {
      query: { candidates, state: 'visible' },
      matches: (result) => result.count === 0,
    };
  }
  return {
    query: { candidates, state },
    matches: (result) => result.count > 0,
  };
}

function validateCountExpectation(
  expected: number | Readonly<{ min?: number; max?: number }>
): number | Readonly<{ min?: number; max?: number }> {
  if (typeof expected === 'number') {
    if (!Number.isInteger(expected) || expected < 0) {
      throw new Error('Browser Skill wait count must be a non-negative integer');
    }
    return expected;
  }
  if (expected.min === undefined && expected.max === undefined) {
    throw new Error('Browser Skill wait count range requires min or max');
  }
  for (const [name, value] of Object.entries(expected)) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`Browser Skill wait count ${name} must be a non-negative integer`);
    }
  }
  if (expected.min !== undefined && expected.max !== undefined && expected.min > expected.max) {
    throw new Error('Browser Skill wait count min cannot exceed max');
  }
  return expected;
}

function countMatches(
  actual: number,
  expected: number | Readonly<{ min?: number; max?: number }>
): boolean {
  if (typeof expected === 'number') return actual === expected;
  return (
    (expected.min === undefined || actual >= expected.min) &&
    (expected.max === undefined || actual <= expected.max)
  );
}

function extractionState(state: 'attached' | 'visible' | undefined): 'attached' | 'visible' {
  const validated = elementState(state, 'visible');
  if (validated !== 'attached' && validated !== 'visible') {
    throw new Error('Browser Skill extraction state must be attached or visible');
  }
  return validated;
}

function elementState(
  state: BrowserSkillElementState | undefined,
  fallback: BrowserSkillElementState
): BrowserSkillElementState {
  const value = state ?? fallback;
  if (!['attached', 'visible', 'actionable', 'hidden'].includes(value)) {
    throw new Error(`Invalid Browser Skill element state: ${JSON.stringify(value)}`);
  }
  return value;
}

function serializeText(value: BrowserSkillText): SerializableText {
  return typeof value === 'string'
    ? { kind: 'literal', value }
    : { kind: 'regexp', source: value.source, flags: value.flags };
}

const STANDARD_DOM_ROLES = new Set([
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'blockquote',
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'definition',
  'deletion',
  'dialog',
  'directory',
  'document',
  'emphasis',
  'feed',
  'figure',
  'form',
  'generic',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'insertion',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'marquee',
  'math',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'meter',
  'navigation',
  'none',
  'note',
  'option',
  'paragraph',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'strong',
  'subscript',
  'superscript',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'time',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
]);

const ACCESSIBILITY_ONLY_ROLES = new Set([
  'ignored',
  'inlinetextbox',
  'linebreak',
  'rootwebarea',
  'statictext',
  'webarea',
]);

function serializeLocator(locator: BrowserSkillLocator): SerializableLocator {
  if ('css' in locator) {
    if (!locator.css.trim()) throw new Error('CSS locator cannot be empty');
    return { kind: 'css', css: locator.css };
  }
  if ('role' in locator) {
    if (!locator.role.trim()) throw new Error('Role locator cannot be empty');
    const role = locator.role.trim().toLowerCase();
    if (ACCESSIBILITY_ONLY_ROLES.has(role)) {
      throw new Error(
        `Accessibility snapshot role ${JSON.stringify(locator.role)} is not a DOM locator role`
      );
    }
    if (!STANDARD_DOM_ROLES.has(role)) {
      throw new Error(
        `Role locator must use a standard HTML/ARIA DOM role: ${JSON.stringify(locator.role)}`
      );
    }
    return {
      kind: 'role',
      role,
      ...(locator.name !== undefined ? { name: serializeText(locator.name) } : {}),
    };
  }
  if ('label' in locator) return { kind: 'label', label: serializeText(locator.label) };
  if ('placeholder' in locator) {
    return { kind: 'placeholder', placeholder: serializeText(locator.placeholder) };
  }
  return {
    kind: 'text',
    text: serializeText(locator.text),
    ...(locator.within ? { within: serializeLocator(locator.within) } : {}),
  };
}

function renderLocator(locator: BrowserSkillLocator): string {
  if ('css' in locator) return `css=${JSON.stringify(locator.css)}`;
  if ('role' in locator)
    return `role=${JSON.stringify(locator.role)}, name=${String(locator.name ?? '*')}`;
  if ('label' in locator) return `label=${String(locator.label)}`;
  if ('placeholder' in locator) return `placeholder=${String(locator.placeholder)}`;
  return `text=${String(locator.text)}`;
}

async function resolveElement(
  page: BrowserPage,
  locator: SerializableLocator,
  requirement: BrowserElementRequirement
): Promise<ResolvedBrowserElement> {
  const handle = await page.evaluateHandle(findPageElement, {
    candidates: [locator],
    state: requirement,
  } satisfies SerializableLocatorQuery);
  const element = handle.asElement() as BrowserElement | null;
  if (!element) await handle.dispose();
  return { element };
}

function timeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < 0) throw new Error('timeoutMs must be non-negative');
  return value;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return Math.floor(value);
}

function validateAttribute(attribute: string | undefined): void {
  if (attribute !== undefined && !/^[A-Za-z_:][-A-Za-z0-9_:.]*$/u.test(attribute)) {
    throw new Error(`Invalid attribute name: ${JSON.stringify(attribute)}`);
  }
}

function matchesText(actual: string, expected: BrowserSkillText): boolean {
  return typeof expected === 'string'
    ? actual.includes(expected)
    : new RegExp(expected.source, expected.flags).test(actual);
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Browser Skill call was cancelled'));
      return;
    }
    const timer = setTimeout(finish, ms);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new Error('Browser Skill call was cancelled'));
    };
    function finish(): void {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function pollDelay(
  deadline: number,
  interval: number,
  signal: AbortSignal
): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  await abortableDelay(Math.min(interval, remaining), signal);
  return true;
}

// The following page functions accept only validated, structured data. They are not exposed to Skill code.
function findPageElement(query: SerializableLocatorQuery): Element | null {
  const normalize = (value: string | null | undefined): string =>
    (value ?? '').replace(/\s+/g, ' ').trim();
  const test = (value: string, expected: SerializableText): boolean => {
    const actual = normalize(value);
    return expected.kind === 'literal'
      ? actual.includes(normalize(expected.value))
      : new RegExp(expected.source, expected.flags).test(actual);
  };
  const implicitRole = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'select') return element.hasAttribute('multiple') ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'aside') return 'complementary';
    if (tag === 'article') return 'article';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'table') return 'table';
    if (tag === 'tr') return 'row';
    if (tag === 'td') return 'cell';
    if (tag === 'th') return element.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader';
    if (/^h[1-6]$/u.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    if (tag === 'option') return 'option';
    if (tag === 'progress') return 'progressbar';
    if (tag === 'input') {
      const type = (element.getAttribute('type') ?? 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (type !== 'hidden' && type !== 'password') return 'textbox';
    }
    return '';
  };
  const accessibleName = (element: Element): string => {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      return labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
    }
    const id = element.getAttribute('id');
    const label = id
      ? [...document.querySelectorAll('label')].find((candidate) => candidate.htmlFor === id)
      : element.closest('label');
    const inputType =
      element.tagName.toLowerCase() === 'input'
        ? (element.getAttribute('type') ?? 'text').toLowerCase()
        : '';
    const inputButtonName = ['button', 'submit', 'reset'].includes(inputType)
      ? (element as HTMLInputElement).value
      : '';
    const explicitName =
      element.getAttribute('aria-label') ??
      label?.textContent ??
      element.getAttribute('alt') ??
      element.getAttribute('title');
    return explicitName ?? (inputButtonName || element.textContent || '');
  };
  const descendants = (root: ParentNode): Element[] => [...root.querySelectorAll('*')];
  const unique = (elements: readonly Element[]): Element[] => [...new Set(elements)];
  const all = (root: ParentNode, locator: SerializableLocator): Element[] => {
    let found: Element[] = [];
    if (locator.kind === 'css') {
      try {
        found = [
          ...(root instanceof Element && root.matches(locator.css) ? [root] : []),
          ...root.querySelectorAll(locator.css),
        ];
      } catch {
        return [];
      }
    } else if (locator.kind === 'role') {
      found = [...(root instanceof Element ? [root] : []), ...descendants(root)].filter(
        (element) => {
          const role = (element.getAttribute('role') ?? implicitRole(element)).toLowerCase();
          return (
            role === locator.role && (!locator.name || test(accessibleName(element), locator.name))
          );
        }
      );
    } else if (locator.kind === 'label') {
      const labels = [
        ...(root instanceof Element && root.tagName.toLowerCase() === 'label' ? [root] : []),
        ...root.querySelectorAll('label'),
      ].filter((label) => test(label.textContent ?? '', locator.label));
      found = labels
        .map(
          (label) =>
            (label as HTMLLabelElement).control ??
            label.querySelector('input,textarea,select,button')
        )
        .filter((element): element is Element => Boolean(element));
    } else if (locator.kind === 'placeholder') {
      found = [...(root instanceof Element ? [root] : []), ...descendants(root)].filter((element) =>
        test(element.getAttribute('placeholder') ?? '', locator.placeholder)
      );
    } else {
      const scopes = locator.within ? all(root, locator.within) : [root];
      found = scopes
        .flatMap((scope) => [...(scope instanceof Element ? [scope] : []), ...descendants(scope)])
        .filter((element) => test(element.textContent ?? '', locator.text));
      const leaves = found.filter(
        (element) =>
          ![...element.children].some((child) => test(child.textContent ?? '', locator.text))
      );
      if (leaves.length > 0) found = leaves;
    }
    return unique(found);
  };
  const visible = (element: Element): boolean => {
    if (!element.isConnected) return false;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = window.getComputedStyle(current);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        Number.parseFloat(style.opacity || '1') <= 0
      ) {
        return false;
      }
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  for (const candidate of query.candidates) {
    const matches = all(document, candidate);
    const eligible = query.state === 'attached' ? matches : matches.filter(visible);
    if (eligible.length > 0) return eligible[0];
  }
  return null;
}

async function queryPageLocator(query: SerializableLocatorQuery): Promise<LocatorQueryResult> {
  const normalize = (value: string | null | undefined): string =>
    (value ?? '').replace(/\s+/g, ' ').trim();
  const test = (value: string, expected: SerializableText): boolean => {
    const actual = normalize(value);
    return expected.kind === 'literal'
      ? actual.includes(normalize(expected.value))
      : new RegExp(expected.source, expected.flags).test(actual);
  };
  const implicitRole = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'select') return element.hasAttribute('multiple') ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'aside') return 'complementary';
    if (tag === 'article') return 'article';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'table') return 'table';
    if (tag === 'tr') return 'row';
    if (tag === 'td') return 'cell';
    if (tag === 'th') return element.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader';
    if (/^h[1-6]$/u.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    if (tag === 'option') return 'option';
    if (tag === 'progress') return 'progressbar';
    if (tag === 'input') {
      const type = (element.getAttribute('type') ?? 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (type !== 'hidden' && type !== 'password') return 'textbox';
    }
    return '';
  };
  const accessibleName = (element: Element): string => {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      return labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
    }
    const id = element.getAttribute('id');
    const label = id
      ? [...document.querySelectorAll('label')].find((candidate) => candidate.htmlFor === id)
      : element.closest('label');
    const inputType =
      element.tagName.toLowerCase() === 'input'
        ? (element.getAttribute('type') ?? 'text').toLowerCase()
        : '';
    const inputButtonName = ['button', 'submit', 'reset'].includes(inputType)
      ? (element as HTMLInputElement).value
      : '';
    const explicitName =
      element.getAttribute('aria-label') ??
      label?.textContent ??
      element.getAttribute('alt') ??
      element.getAttribute('title');
    return explicitName ?? (inputButtonName || element.textContent || '');
  };
  const descendants = (root: ParentNode): Element[] => [...root.querySelectorAll('*')];
  const unique = (elements: readonly Element[]): Element[] => [...new Set(elements)];
  const all = (root: ParentNode, locator: SerializableLocator): Element[] => {
    let found: Element[] = [];
    if (locator.kind === 'css') {
      try {
        found = [
          ...(root instanceof Element && root.matches(locator.css) ? [root] : []),
          ...root.querySelectorAll(locator.css),
        ];
      } catch {
        return [];
      }
    } else if (locator.kind === 'role') {
      found = [...(root instanceof Element ? [root] : []), ...descendants(root)].filter(
        (element) => {
          const role = (element.getAttribute('role') ?? implicitRole(element)).toLowerCase();
          return (
            role === locator.role && (!locator.name || test(accessibleName(element), locator.name))
          );
        }
      );
    } else if (locator.kind === 'label') {
      const labels = [
        ...(root instanceof Element && root.tagName.toLowerCase() === 'label' ? [root] : []),
        ...root.querySelectorAll('label'),
      ].filter((label) => test(label.textContent ?? '', locator.label));
      found = labels
        .map(
          (label) =>
            (label as HTMLLabelElement).control ??
            label.querySelector('input,textarea,select,button')
        )
        .filter((element): element is Element => Boolean(element));
    } else if (locator.kind === 'placeholder') {
      found = [...(root instanceof Element ? [root] : []), ...descendants(root)].filter((element) =>
        test(element.getAttribute('placeholder') ?? '', locator.placeholder)
      );
    } else {
      const scopes = locator.within ? all(root, locator.within) : [root];
      found = scopes
        .flatMap((scope) => [...(scope instanceof Element ? [scope] : []), ...descendants(scope)])
        .filter((element) => test(element.textContent ?? '', locator.text));
      const leaves = found.filter(
        (element) =>
          ![...element.children].some((child) => test(child.textContent ?? '', locator.text))
      );
      if (leaves.length > 0) found = leaves;
    }
    return unique(found);
  };
  const visible = (element: Element): boolean => {
    if (!element.isConnected) return false;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = window.getComputedStyle(current);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        Number.parseFloat(style.opacity || '1') <= 0
      ) {
        return false;
      }
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const actionable = async (element: Element): Promise<boolean> => {
    if (!visible(element)) return false;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const html = current as HTMLElement;
      const style = window.getComputedStyle(current);
      if (
        style.pointerEvents === 'none' ||
        html.inert ||
        current.hasAttribute('inert') ||
        current.getAttribute('aria-disabled')?.toLowerCase() === 'true'
      ) {
        return false;
      }
    }
    const control = element as HTMLButtonElement;
    if (Boolean(control.disabled) || element.hasAttribute('disabled')) return false;
    const first = element.getBoundingClientRect();
    const viewportWidth = document.documentElement?.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement?.clientHeight || window.innerHeight;
    if (
      first.right <= 0 ||
      first.bottom <= 0 ||
      first.left >= viewportWidth ||
      first.top >= viewportHeight
    ) {
      return false;
    }
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    if (!element.isConnected || !visible(element)) return false;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const html = current as HTMLElement;
      const style = window.getComputedStyle(current);
      if (
        style.pointerEvents === 'none' ||
        html.inert ||
        current.hasAttribute('inert') ||
        current.getAttribute('aria-disabled')?.toLowerCase() === 'true'
      ) {
        return false;
      }
    }
    if (Boolean(control.disabled) || element.hasAttribute('disabled')) return false;
    const second = element.getBoundingClientRect();
    const stable =
      Math.abs(first.left - second.left) <= 0.5 &&
      Math.abs(first.top - second.top) <= 0.5 &&
      Math.abs(first.width - second.width) <= 0.5 &&
      Math.abs(first.height - second.height) <= 0.5;
    if (!stable) return false;
    const left = Math.max(0, second.left);
    const right = Math.min(viewportWidth, second.right);
    const top = Math.max(0, second.top);
    const bottom = Math.min(viewportHeight, second.bottom);
    if (right <= left || bottom <= top) return false;
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    return Boolean(hit && (hit === element || element.contains(hit)));
  };
  for (const candidate of query.candidates) {
    const matches = all(document, candidate);
    let eligible: Element[];
    if (query.state === 'attached') {
      eligible = matches;
    } else if (query.state === 'visible') {
      eligible = matches.filter(visible);
    } else {
      eligible = [];
      for (const element of matches) {
        if (await actionable(element)) eligible.push(element);
      }
    }
    if (eligible.length === 0) continue;
    const target = eligible[0] as HTMLInputElement;
    if (query.read?.kind === 'value') {
      return {
        count: eligible.length,
        value: typeof target.value === 'string' ? target.value : null,
      };
    }
    if (query.read?.kind === 'attribute') {
      return { count: eligible.length, value: target.getAttribute(query.read.name) };
    }
    return { count: eligible.length };
  }
  return { count: 0 };
}

function scrollElementIntoView(element: Element): boolean {
  if (!element.isConnected) return false;
  element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
  return true;
}

async function inspectElementActionability(element: Element): Promise<ActionabilityReport> {
  const limited = (value: string | null, max: number): string | undefined => {
    const normalized = value?.trim();
    return normalized ? normalized.slice(0, max) : undefined;
  };
  const bounded = (value: number): number => {
    const finite = Number.isFinite(value) ? value : 0;
    return Math.max(-1_000_000, Math.min(1_000_000, Math.round(finite * 100) / 100));
  };
  const summarize = (target: Element): ElementSummary => ({
    tag: target.tagName.toLowerCase(),
    ...(limited(target.getAttribute('id'), 80)
      ? { id: limited(target.getAttribute('id'), 80) }
      : {}),
    ...(limited(target.getAttribute('role'), 40)
      ? { role: limited(target.getAttribute('role'), 40) }
      : {}),
    ...(limited(target.getAttribute('data-testid'), 80)
      ? { testId: limited(target.getAttribute('data-testid'), 80) }
      : {}),
    ...(limited(target.getAttribute('class'), 120)
      ? { className: limited(target.getAttribute('class'), 120) }
      : {}),
  });
  const target = summarize(element);
  if (!element.isConnected) {
    return { attached: false, visible: false, actionable: false, reason: 'detached', target };
  }
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    if (style.display === 'none') {
      return { attached: true, visible: false, actionable: false, reason: 'display-none', target };
    }
    if (style.visibility === 'hidden' || style.visibility === 'collapse') {
      return {
        attached: true,
        visible: false,
        actionable: false,
        reason: 'visibility-hidden',
        target,
      };
    }
    if (Number.parseFloat(style.opacity || '1') <= 0) {
      return { attached: true, visible: false, actionable: false, reason: 'opacity-zero', target };
    }
  }
  const first = element.getBoundingClientRect();
  const viewportWidth = document.documentElement?.clientWidth || window.innerWidth;
  const viewportHeight = document.documentElement?.clientHeight || window.innerHeight;
  const geometry = (rect: DOMRect): Pick<ActionabilityReport, 'rect' | 'viewport'> => ({
    rect: {
      left: bounded(rect.left),
      top: bounded(rect.top),
      right: bounded(rect.right),
      bottom: bounded(rect.bottom),
      width: bounded(rect.width),
      height: bounded(rect.height),
    },
    viewport: { width: bounded(viewportWidth), height: bounded(viewportHeight) },
  });
  if (first.width <= 0 || first.height <= 0) {
    return {
      attached: true,
      visible: false,
      actionable: false,
      reason: 'empty-rectangle',
      target,
      ...geometry(first),
    };
  }
  for (let current: Element | null = element; current; current = current.parentElement) {
    const html = current as HTMLElement;
    const style = window.getComputedStyle(current);
    if (html.inert || current.hasAttribute('inert')) {
      return {
        attached: true,
        visible: true,
        actionable: false,
        reason: 'inert',
        target,
        ...geometry(first),
      };
    }
    if (current.getAttribute('aria-disabled')?.toLowerCase() === 'true') {
      return {
        attached: true,
        visible: true,
        actionable: false,
        reason: 'aria-disabled',
        target,
        ...geometry(first),
      };
    }
    if (style.pointerEvents === 'none') {
      return {
        attached: true,
        visible: true,
        actionable: false,
        reason: 'pointer-events-none',
        target,
        ...geometry(first),
      };
    }
  }
  const control = element as HTMLButtonElement;
  if (Boolean(control.disabled) || element.hasAttribute('disabled')) {
    return {
      attached: true,
      visible: true,
      actionable: false,
      reason: 'disabled',
      target,
      ...geometry(first),
    };
  }
  if (
    first.right <= 0 ||
    first.bottom <= 0 ||
    first.left >= viewportWidth ||
    first.top >= viewportHeight
  ) {
    return {
      attached: true,
      visible: true,
      actionable: false,
      reason: 'outside-viewport',
      target,
      ...geometry(first),
    };
  }
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  if (!element.isConnected) {
    return { attached: false, visible: false, actionable: false, reason: 'detached', target };
  }
  for (let current: Element | null = element; current; current = current.parentElement) {
    const html = current as HTMLElement;
    const style = window.getComputedStyle(current);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      Number.parseFloat(style.opacity || '1') <= 0
    ) {
      return {
        attached: true,
        visible: false,
        actionable: false,
        reason: 'became-hidden',
        target,
        ...geometry(first),
      };
    }
    if (
      html.inert ||
      current.hasAttribute('inert') ||
      current.getAttribute('aria-disabled')?.toLowerCase() === 'true' ||
      style.pointerEvents === 'none'
    ) {
      return {
        attached: true,
        visible: true,
        actionable: false,
        reason: 'became-blocked',
        target,
        ...geometry(first),
      };
    }
  }
  if (Boolean(control.disabled) || element.hasAttribute('disabled')) {
    return {
      attached: true,
      visible: true,
      actionable: false,
      reason: 'disabled',
      target,
      ...geometry(first),
    };
  }
  const second = element.getBoundingClientRect();
  const stable =
    Math.abs(first.left - second.left) <= 0.5 &&
    Math.abs(first.top - second.top) <= 0.5 &&
    Math.abs(first.width - second.width) <= 0.5 &&
    Math.abs(first.height - second.height) <= 0.5;
  if (!stable) {
    return {
      attached: true,
      visible: true,
      actionable: false,
      reason: 'unstable-rectangle',
      target,
      ...geometry(second),
    };
  }
  const left = Math.max(0, second.left);
  const right = Math.min(viewportWidth, second.right);
  const top = Math.max(0, second.top);
  const bottom = Math.min(viewportHeight, second.bottom);
  if (right <= left || bottom <= top) {
    return {
      attached: true,
      visible: true,
      actionable: false,
      reason: 'outside-viewport',
      target,
      ...geometry(second),
    };
  }
  const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
  if (!hit || (hit !== element && !element.contains(hit))) {
    return {
      attached: true,
      visible: true,
      actionable: false,
      reason: 'hit-target-mismatch',
      target,
      ...(hit ? { hit: summarize(hit) } : {}),
      ...geometry(second),
    };
  }
  return {
    attached: true,
    visible: true,
    actionable: true,
    target,
    hit: summarize(hit),
    ...geometry(second),
  };
}

function matchesPageText(expected: SerializableText): boolean {
  const actual = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
  return expected.kind === 'literal'
    ? actual.includes(expected.value.replace(/\s+/g, ' ').trim())
    : new RegExp(expected.source, expected.flags).test(actual);
}

function extractElementValue(
  element: Element,
  request: { attribute?: string; normalizeWhitespace: boolean }
): string | null {
  const raw =
    request.attribute === undefined ? element.textContent : element.getAttribute(request.attribute);
  if (raw === null) return null;
  return request.normalizeWhitespace ? raw.replace(/\s+/g, ' ').trim() : raw;
}

function extractPageList(request: {
  candidates: readonly SerializableLocator[];
  fields: Readonly<Record<string, SerializableListField>>;
  limit: number;
  state: 'attached' | 'visible';
}): Record<string, string | null>[] {
  const normalizeText = (value: string | null | undefined): string =>
    (value ?? '').replace(/\s+/g, ' ').trim();
  const normalize = (value: string | null, enabled: boolean): string | null =>
    value === null ? null : enabled ? normalizeText(value) : value;
  const matches = (actual: string, expected: SerializableText): boolean => {
    const normalized = normalizeText(actual);
    return expected.kind === 'literal'
      ? normalized.includes(normalizeText(expected.value))
      : new RegExp(expected.source, expected.flags).test(normalized);
  };
  const visible = (element: Element): boolean => {
    if (!element.isConnected) return false;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = window.getComputedStyle(current);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        Number.parseFloat(style.opacity || '1') <= 0
      ) {
        return false;
      }
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const implicitRole = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (element.getAttribute('type') ?? 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'textbox';
    }
    return '';
  };
  const accessibleName = (element: Element): string => {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      return labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
    }
    const id = element.getAttribute('id');
    const label = id
      ? [...document.querySelectorAll('label')].find((candidate) => candidate.htmlFor === id)
      : element.closest('label');
    const inputType =
      element.tagName.toLowerCase() === 'input'
        ? (element.getAttribute('type') ?? 'text').toLowerCase()
        : '';
    const inputButtonName = ['button', 'submit', 'reset'].includes(inputType)
      ? (element as HTMLInputElement).value
      : '';
    const explicitName =
      element.getAttribute('aria-label') ??
      label?.textContent ??
      element.getAttribute('alt') ??
      element.getAttribute('title');
    return explicitName ?? (inputButtonName || element.textContent || '');
  };
  const descendants = (root: ParentNode): Element[] => [...root.querySelectorAll('*')];
  const unique = (elements: readonly Element[]): Element[] => [...new Set(elements)];
  const all = (root: ParentNode, locator: SerializableLocator): Element[] => {
    let found: Element[] = [];
    if (locator.kind === 'css') {
      try {
        found = [
          ...(root instanceof Element && root.matches(locator.css) ? [root] : []),
          ...root.querySelectorAll(locator.css),
        ];
      } catch {
        return [];
      }
    } else if (locator.kind === 'placeholder') {
      found = [...(root instanceof Element ? [root] : []), ...descendants(root)].filter((element) =>
        matches(element.getAttribute('placeholder') ?? '', locator.placeholder)
      );
    } else if (locator.kind === 'label') {
      const labels = [
        ...(root instanceof HTMLLabelElement ? [root] : []),
        ...root.querySelectorAll('label'),
      ].filter((label) => matches(label.textContent ?? '', locator.label));
      found = labels
        .map((label) => label.control ?? label.querySelector('input,textarea,select,button'))
        .filter((element): element is Element => Boolean(element));
    } else if (locator.kind === 'role') {
      found = [...(root instanceof Element ? [root] : []), ...descendants(root)].filter(
        (element) => {
          const role = (element.getAttribute('role') ?? implicitRole(element)).toLowerCase();
          return (
            role === locator.role &&
            (!locator.name || matches(accessibleName(element), locator.name))
          );
        }
      );
    } else {
      const scopes = locator.within ? all(root, locator.within) : [root];
      found = scopes
        .flatMap((scope) => [...(scope instanceof Element ? [scope] : []), ...descendants(scope)])
        .filter((element) => matches(element.textContent ?? '', locator.text));
    }
    const deduplicated = unique(found);
    return request.state === 'attached' ? deduplicated : deduplicated.filter(visible);
  };
  const find = (root: ParentNode, locator: SerializableLocator): Element | null => {
    return all(root, locator)[0] ?? null;
  };
  let items: Element[] = [];
  for (const candidate of request.candidates) {
    items = all(document, candidate);
    if (items.length > 0) break;
  }
  return items.slice(0, request.limit).map((item) =>
    Object.fromEntries(
      Object.entries(request.fields).map(([name, field]) => {
        const target = field.locator ? find(item, field.locator) : item;
        const raw = !target
          ? null
          : field.attribute === undefined
            ? target.textContent
            : target.getAttribute(field.attribute);
        return [name, normalize(raw, field.normalizeWhitespace)];
      })
    )
  );
}
