/**
 * 内嵌浏览器面板状态——主进程 EmbeddedBrowserService 推给渲染层的快照。
 */
export interface EmbeddedBrowserState {
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}
