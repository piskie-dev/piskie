/** Snapshot of one conversation target's embedded preview page. */
export interface EmbeddedBrowserState {
  readonly open: boolean;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export const EMPTY_EMBEDDED_BROWSER_STATE: EmbeddedBrowserState = Object.freeze({
  open: false,
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
});
