/**
 * 语法高亮 —— 审阅面板用的极简分词器。纯函数，零依赖，零异步。
 *
 * ## 为什么自己写
 *
 * 项目里没有任何高亮器（`@ant-design/x-markdown` 不带）。三个选项：
 *
 * | 方案 | 代价 |
 * |---|---|
 * | shiki | 保真度最好（VS Code 同一套 TextMate 语法），但要 WASM + 语法 JSON、异步 API、1–2MB |
 * | highlight.js | 只返回 HTML 字符串，**没有 token API** |
 * | 本文件 | ~200 行纯函数，错了只是某个 token 颜色不对，不影响正确性 |
 *
 * 决定性约束是**跨行结构**：块注释、模板字符串、多行字符串。审阅面板逐行渲染，
 * 按行独立高亮必然错（`/*` 开在上一行，下一行就不知道自己在注释里）。所以必须
 * **整篇分词、再按行切** —— 这需要 token 级 API，highlight.js 给不了；shiki 给得了
 * 但代价大。于是自己写，把"整篇分词后按 `\n` 切开"作为核心不变量。
 *
 * ## 明确不做的事
 *
 * **不重排版。** 压缩过的 JS 不会被展开、缩进不会被规整 —— 审阅面板必须如实反映盘上的
 * 内容，重排版会让"看到的"和"文件里的"不一致。beautify 在这里只指着色。
 *
 * ## 精度取舍
 *
 * 这不是解析器，是**一遍扫描的分词器**：位置 i 处按顺序试各条规则，先命中者胜，
 * 都不命中就吞掉一个字符当 plain。因此这些情况会认错，且都是可接受的：
 * - 模板字符串里的 `${expr}` 整体算字符串（不进去着色）
 * - JS 正则字面量 `/re/g` 会被当成除号 + 内容
 * - HTML 正文里形如 `foo=` 的裸文本会被当属性名
 * - shell 双引号内的 `$VAR` 整体算字符串（不做嵌套着色，与模板字符串同理）
 *
 * 认错只影响颜色。**唯一不能错的是"不能吞掉或改写字符"** —— 由
 * `__tests__/highlight.test.ts` 的"拼回原文"断言守住。
 */

export type TokenKind =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'tag'
  | 'attr'
  | 'property'
  | 'func'
  | 'punct';

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

export type Grammar = 'clike' | 'python' | 'html' | 'css' | 'json' | 'shell' | 'yaml' | 'markdown' | 'plain';

interface Rule {
  readonly kind: TokenKind;
  readonly re: RegExp;
}

/**
 * 规则顺序即优先级：注释与字符串必须在标点、关键字之前。
 *
 * 关键字表**故意只收 JS/TS 家族**，不塞 Rust/Go 的 `fn` / `func` / `use` / `match` /
 * `self` / `nil` / `go` —— 它们都是极常见的 JS 标识符名。一张表服务多语言时，
 * **误染常见标识符比漏染小众关键字更糟**（前者天天见，后者只在那门语言里少个颜色）。
 * 单测里 `const n = fn(...)` 那一例就是被这个坑出来的。
 */
const CLIKE_KEYWORDS =
  'const|let|var|function|return|if|else|for|while|do|class|extends|new|await|async|import|export|from|default|type|interface|enum|try|catch|finally|throw|switch|case|break|continue|typeof|instanceof|in|of|this|super|null|undefined|true|false|void|delete|yield|static|readonly|public|private|protected|abstract|implements|declare|namespace|as|is|satisfies|struct|impl|pub|package';

const RULES: Record<Exclude<Grammar, 'plain'>, readonly Rule[]> = {
  clike: [
    { kind: 'comment', re: /\/\/[^\n]*/y },
    { kind: 'comment', re: /\/\*[\s\S]*?(?:\*\/|$)/y },
    { kind: 'string', re: /"(?:\\[\s\S]|[^"\\])*"?/y },
    { kind: 'string', re: /'(?:\\[\s\S]|[^'\\])*'?/y },
    { kind: 'string', re: /`(?:\\[\s\S]|[^`\\])*`?/y },
    { kind: 'number', re: /\b0[xXbBoO][\da-fA-F_]+|\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/y },
    { kind: 'keyword', re: new RegExp(`\\b(?:${CLIKE_KEYWORDS})\\b`, 'y') },
    { kind: 'func', re: /\b[A-Za-z_$][\w$]*(?=\s*\()/y },
    { kind: 'punct', re: /[{}()[\].,;:?!<>=+\-*/%&|^~]+/y },
  ],
  python: [
    { kind: 'comment', re: /#[^\n]*/y },
    { kind: 'string', re: /(?:"""|''')[\s\S]*?(?:"""|'''|$)/y },
    { kind: 'string', re: /[rbfu]?"(?:\\[\s\S]|[^"\\])*"?/y },
    { kind: 'string', re: /[rbfu]?'(?:\\[\s\S]|[^'\\])*'?/y },
    { kind: 'number', re: /\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/y },
    {
      kind: 'keyword',
      re: /\b(?:def|class|return|if|elif|else|for|while|in|not|and|or|import|from|as|with|try|except|finally|raise|lambda|pass|break|continue|global|nonlocal|yield|assert|del|None|True|False|async|await|self)\b/y,
    },
    { kind: 'func', re: /\b[A-Za-z_][\w]*(?=\s*\()/y },
    { kind: 'punct', re: /[{}()[\].,;:?!<>=+\-*/%&|^~]+/y },
  ],
  html: [
    { kind: 'comment', re: /<!--[\s\S]*?(?:-->|$)/y },
    { kind: 'keyword', re: /<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<!doctype[^>]*>?/iy },
    { kind: 'tag', re: /<\/?[A-Za-z][\w:-]*/y },
    { kind: 'string', re: /"[^"]*"?|'[^']*'?/y },
    { kind: 'attr', re: /[A-Za-z_:@][\w:.-]*(?=\s*=)/y },
    { kind: 'tag', re: /\/?>/y },
  ],
  css: [
    { kind: 'comment', re: /\/\*[\s\S]*?(?:\*\/|$)/y },
    { kind: 'string', re: /"[^"]*"?|'[^']*'?/y },
    { kind: 'keyword', re: /@[\w-]+/y },
    { kind: 'property', re: /--?[A-Za-z][\w-]*(?=\s*:)|[a-z-]+(?=\s*:)/y },
    { kind: 'tag', re: /[.#][\w-]+|::?[a-z-]+|&/y },
    { kind: 'number', re: /-?\d*\.?\d+(?:px|rem|em|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex|pt)?/y },
    { kind: 'func', re: /\b[a-z-]+(?=\()/y },
    { kind: 'punct', re: /[{}()[\],;:>+~*]+/y },
  ],
  json: [
    { kind: 'property', re: /"(?:\\[\s\S]|[^"\\])*"(?=\s*:)/y },
    { kind: 'string', re: /"(?:\\[\s\S]|[^"\\])*"?/y },
    { kind: 'keyword', re: /\b(?:true|false|null)\b/y },
    { kind: 'number', re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y },
    { kind: 'punct', re: /[{}[\],:]+/y },
  ],
  shell: [
    { kind: 'comment', re: /#[^\n]*/y },
    { kind: 'string', re: /"(?:\\[\s\S]|[^"\\])*"?|'[^']*'?/y },
    { kind: 'property', re: /\$\{[^}]*\}?|\$[\w@#?*!$]+/y },
    {
      kind: 'keyword',
      re: /\b(?:if|then|elif|else|fi|for|in|do|done|case|esac|while|until|function|return|export|local|readonly|source|set|unset|shift|trap|exit)\b/y,
    },
    { kind: 'attr', re: /--?[A-Za-z][\w-]*/y },
    { kind: 'number', re: /\b\d+\b/y },
    { kind: 'punct', re: /[|&;()<>]+/y },
  ],
  yaml: [
    { kind: 'comment', re: /#[^\n]*/y },
    { kind: 'string', re: /"(?:\\[\s\S]|[^"\\])*"?|'[^']*'?/y },
    { kind: 'property', re: /[\w.$-]+(?=\s*:)/y },
    { kind: 'keyword', re: /\b(?:true|false|null|yes|no|on|off)\b/y },
    { kind: 'number', re: /-?\b\d+(?:\.\d+)?\b/y },
    { kind: 'punct', re: /^[ \t]*-\s|[[\]{},:>|]+/y },
  ],
  markdown: [
    { kind: 'string', re: /```[\s\S]*?(?:```|$)|`[^`\n]*`?/y },
    { kind: 'keyword', re: /#{1,6}[^\n]*/y },
    { kind: 'attr', re: /!?\[[^\]\n]*\](?:\([^)\n]*\))?/y },
    { kind: 'comment', re: /^>[^\n]*/y },
    { kind: 'punct', re: /\*{1,3}|_{1,3}|^[-*+]\s|^\d+\.\s|^[-=]{3,}/y },
  ],
};

const BY_EXTENSION: Readonly<Record<string, Grammar>> = {
  js: 'clike', jsx: 'clike', mjs: 'clike', cjs: 'clike',
  ts: 'clike', tsx: 'clike', mts: 'clike', cts: 'clike',
  java: 'clike', c: 'clike', h: 'clike', cc: 'clike', cpp: 'clike', hpp: 'clike',
  cs: 'clike', go: 'clike', rs: 'clike', swift: 'clike', kt: 'clike', kts: 'clike',
  php: 'clike', dart: 'clike', scala: 'clike', m: 'clike', mm: 'clike',
  py: 'python', pyi: 'python',
  html: 'html', htm: 'html', xhtml: 'html', xml: 'html', svg: 'html',
  vue: 'html', svelte: 'html', hbs: 'html', ejs: 'html',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  json: 'json', jsonc: 'json', json5: 'json',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ksh: 'shell',
  yml: 'yaml', yaml: 'yaml',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
};

/** 没有扩展名但约定俗成的文件名 */
const BY_BASENAME: Readonly<Record<string, Grammar>> = {
  dockerfile: 'shell',
  makefile: 'shell',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
  '.env': 'shell',
  '.gitignore': 'plain',
};

export function grammarForPath(filePath: string): Grammar {
  const name = (filePath.replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase();
  const known = BY_BASENAME[name];
  if (known) return known;

  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'plain';
  return BY_EXTENSION[name.slice(dot + 1)] ?? 'plain';
}

/** 把含换行的 token 拆成多个，每个不跨行；换行本身不进 token */
function pushSplit(lines: Token[][], kind: TokenKind, text: string): void {
  const parts = text.split('\n');
  parts.forEach((part, index) => {
    if (index > 0) lines.push([]);
    if (part) lines[lines.length - 1]!.push({ kind, text: part });
  });
}

/**
 * **整篇分词后按行切**（本文件的核心不变量）。
 * 返回按行分组的 token；第 i 项对应第 i+1 行。空行是空数组。
 */
export function tokenize(text: string, grammar: Grammar): Token[][] {
  const lines: Token[][] = [[]];
  if (grammar === 'plain') {
    pushSplit(lines, 'plain', text);
    return lines;
  }

  const rules = RULES[grammar];
  let index = 0;
  /** 未命中任何规则时累积的普通字符，命中前统一 flush，避免产出一堆单字符 token */
  let plain = '';

  const flushPlain = (): void => {
    if (!plain) return;
    pushSplit(lines, 'plain', plain);
    plain = '';
  };

  while (index < text.length) {
    let matched = false;

    for (const rule of rules) {
      rule.re.lastIndex = index;
      const found = rule.re.exec(text);
      // 零长匹配会导致死循环，必须排除
      if (!found || found[0].length === 0) continue;

      flushPlain();
      pushSplit(lines, rule.kind, found[0]);
      index += found[0].length;
      matched = true;
      break;
    }

    if (!matched) {
      plain += text[index];
      index += 1;
    }
  }

  flushPlain();
  return lines;
}

/**
 * 给 diff 行挂上 token。
 *
 * **必须整篇分词再按行取**，不能对每行单独调 `tokenize`：块注释、模板字符串跨行时，
 * 单行看不出自己在注释里。因此这里分别整篇分词 old / new，再按 `oldNo` / `newNo`
 * 取对应那一行 —— 行号是 1 起且相对本次比对，正好是数组下标 + 1。
 *
 * 新增行取新侧的 token，删除行取旧侧的，上下文行取新侧（两侧文本相同）。
 *
 * **行数闸门**：每个 token 渲染成一个 `<span>`，实测约 4.7 span/行（punct 占七成）。
 * 全量写入一个几千行的文件会产出上万个节点。超过 `MAX_HIGHLIGHT_LINES` 就整段不着色 ——
 * 那种规模的 diff 本来也不是逐行读的，颜色的边际价值远低于节点开销。
 * 阈值取得宽松，正常改动到不了。
 */
export const MAX_HIGHLIGHT_LINES = 3000;

export function attachTokens<T extends { kind: string; text: string; oldNo?: number; newNo?: number }>(
  lines: readonly T[],
  input: { readonly oldText: string; readonly newText: string; readonly grammar: Grammar },
): Array<T & { tokens?: readonly Token[] }> {
  if (input.grammar === 'plain' || lines.length > MAX_HIGHLIGHT_LINES) {
    return lines.map((line) => ({ ...line }));
  }

  const oldLines = tokenize(input.oldText, input.grammar);
  const newLines = tokenize(input.newText, input.grammar);

  return lines.map((line) => {
    const source = line.kind === 'remove' ? oldLines : newLines;
    const at = line.kind === 'remove' ? line.oldNo : (line.newNo ?? line.oldNo);
    const tokens = at !== undefined ? source[at - 1] : undefined;
    return { ...line, tokens };
  });
}
