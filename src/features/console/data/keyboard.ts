/**
 * 焦点作用域键盘路由。
 *
 * **只有一个全局监听**，事件派给当前焦点面板注册的绑定。由面板各自挂全局 keydown +
 * `:hover` 判定归属的话，多面板并存时会同时存在多个监听、鼠标不在任何面板上快捷键失效、
 * 处在重叠区可能双触发，还会作用到用户没在看的那个面板。
 *
 * 分层：路由逻辑（`dispatchKeyEvent`）不依赖 DOM，只吃一个纯对象；
 * DOM 适配（`attachKeyboardListener`）负责把 `KeyboardEvent` 翻译过来。
 * 这样路由可在 node 环境直接单测，无需引入 jsdom。
 */

export interface KeyBinding {
  /** 形如 'mod+b' / 'escape' / 'mod+\\'；`mod` 同时匹配 Cmd 与 Ctrl */
  readonly combo: string;
  readonly run: () => void;
  /** 人读说明；将来做快捷键面板时是唯一来源，现在也便于排查冲突 */
  readonly description?: string;
}

/** 路由只需要这些信息，与 `KeyboardEvent` 解耦 */
export interface KeyEventLike {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  /** 事件源是否可编辑元素（由 DOM 适配层算好） */
  readonly editableTarget?: boolean;
}

interface Scope {
  readonly id: string;
  readonly bindings: readonly KeyBinding[];
}

interface Registry {
  scopes: Map<string, Scope>;
  /** 全局绑定：与焦点无关（模式切换等页面级快捷键） */
  globalBindings: Set<KeyBinding>;
  focusedScopeId: string | null;
}

/**
 * 注册表挂在 globalThis 上做 HMR 单例。
 *
 * 不这样做的后果：dev 下只改本文件时模块被重载、注册表清空，而各面板仍挂载
 * （它们的 `registerScope` effect 不会重跑）→ 快捷键静默失效直到组件重挂载。
 *
 * 这是本渲染层**唯一的跨组件内存态**，且非权威：丢了只是快捷键失灵，没有数据损失。
 */
const REGISTRY_KEY = '__consoleKeyboardRegistry';

const registry: Registry =
  (globalThis as Record<string, unknown>)[REGISTRY_KEY] as Registry ??
  ((globalThis as Record<string, unknown>)[REGISTRY_KEY] = {
    scopes: new Map<string, Scope>(),
    globalBindings: new Set<KeyBinding>(),
    focusedScopeId: null,
  } satisfies Registry);

const { scopes, globalBindings } = registry;

/** `mod` 同时匹配 Cmd 与 Ctrl：既免去平台探测，也让两种习惯都能用 */
export function normalizeCombo(event: KeyEventLike): string {
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('mod');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push(event.key.toLowerCase());
  return parts.join('+');
}

/**
 * 派发一次按键。返回是否命中绑定（命中时调用方应 `preventDefault`）。
 *
 * 优先序：焦点作用域 → 全局绑定。输入态只放行带修饰键的组合，避免劫持打字。
 */
export function dispatchKeyEvent(event: KeyEventLike): boolean {
  const hasModifier = !!(event.metaKey || event.ctrlKey || event.altKey);
  // Esc 不是打字键：在输入框里也要放行（否则焦点在 composer 时 Esc 链断掉）
  const isEscape = event.key === 'Escape';
  if (!hasModifier && !isEscape && event.editableTarget) return false;

  const combo = normalizeCombo(event);
  const focused = registry.focusedScopeId ? scopes.get(registry.focusedScopeId) : undefined;

  const binding =
    focused?.bindings.find((candidate) => candidate.combo === combo) ??
    Array.from(globalBindings).find((candidate) => candidate.combo === combo);

  if (!binding) return false;

  binding.run();
  return true;
}

/** 注册一个面板作用域；返回注销函数 */
export function registerScope(id: string, bindings: readonly KeyBinding[]): () => void {
  scopes.set(id, { id, bindings });

  return () => {
    scopes.delete(id);
    if (registry.focusedScopeId === id) registry.focusedScopeId = null;
  };
}

/** 注册与焦点无关的页面级绑定 */
export function registerGlobalBinding(binding: KeyBinding): () => void {
  globalBindings.add(binding);
  return () => {
    globalBindings.delete(binding);
  };
}

/** 声明当前焦点面板。同一时刻只有一个作用域生效 */
export function focusScope(id: string | null): void {
  registry.focusedScopeId = id;
}

export function getFocusedScope(): string | null {
  return registry.focusedScopeId;
}

/** 仅测试用 */
export function resetKeyboardRegistry(): void {
  scopes.clear();
  globalBindings.clear();
  registry.focusedScopeId = null;
}

// ==================== DOM 适配 ====================

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    target.isContentEditable ||
    !!target.closest('[contenteditable="true"]')
  );
}

/**
 * 是否有原生 overlay 打开（键盘优先级链的第一级）。
 *
 * **不能假设"overlay 自己吞掉 Esc"**：`<dialog>` / popover 关闭 close request 时
 * 并不阻止 keydown 继续冒泡到 window，所以本监听照样会收到那一次 Esc。
 * 必须显式让位，否则一次 Esc 会同时关弹层**并**清掉 worker 选中。
 */
function hasOpenOverlay(): boolean {
  return !!document.querySelector('dialog[open], :popover-open');
}

/**
 * 挂上唯一的全局监听。页面壳挂一次，返回卸载函数。
 *
 * Esc 优先级链在这里落地：最上层原生 overlay 优先（本监听让位），
 * 其余按 `dispatchKeyEvent` 的作用域 → 全局顺序。
 */
export function attachKeyboardListener(target: Window = window): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    // 第一级：有原生 overlay 就完全让位，由浏览器关它
    if (event.key === 'Escape' && hasOpenOverlay()) return;

    const handled = dispatchKeyEvent({
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      editableTarget: isEditableElement(event.target),
    });
    if (handled) event.preventDefault();
  };

  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}
