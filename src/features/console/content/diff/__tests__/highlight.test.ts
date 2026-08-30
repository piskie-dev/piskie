/**
 * 分词器的单测。
 *
 * **最重要的一组是「拼回原文」**：分词器认错颜色只是不好看，但吞掉或改写字符会让
 * 审阅面板显示的内容与盘上的文件不一致 —— 那是审阅功能的根本失效。
 * 所以每个语法都有一条 round-trip 断言。
 *
 * 第二重要的是**跨行结构**：块注释、模板字符串、三引号字符串。按行独立高亮必然错，
 * 本实现的核心不变量是"整篇分词、再按行切"，这里逐条固定住。
 */

import { describe, expect, it } from 'vitest';

import { attachTokens, grammarForPath, MAX_HIGHLIGHT_LINES, tokenize, type Grammar, type Token } from '../highlight';

/** 把分词结果拼回字符串（行内 token 顺序拼接，行间补回 \n） */
function rejoin(lines: readonly (readonly Token[])[]): string {
  return lines.map((line) => line.map((token) => token.text).join('')).join('\n');
}

function kindsOf(lines: readonly (readonly Token[])[], lineIndex: number): string[] {
  return (lines[lineIndex] ?? []).map((token) => token.kind);
}

function textOfKind(lines: readonly (readonly Token[])[], kind: string): string[] {
  return lines.flat().filter((token) => token.kind === kind).map((token) => token.text);
}

// ==================== 不变量：不吞字符 ====================

const SAMPLES: ReadonlyArray<{ grammar: Grammar; text: string }> = [
  {
    grammar: 'clike',
    text: `import { a } from 'b';\n/* 块\n注释 */\nconst x = \`模板 \${y}\`; // 行尾\nfunction f(n) { return n * 0x1f; }\n`,
  },
  { grammar: 'python', text: `def f(x):\n    """文档\n字符串"""\n    return x # 注释\n` },
  { grammar: 'html', text: `<!doctype html>\n<div class="a" data-x='1'>文本 &amp;</div>\n<!-- 注释\n跨行 -->\n` },
  { grammar: 'css', text: `:root {\n  --a: 1px;\n}\n/* c */\n.b::after { content: "x"; width: calc(1rem + 2%); }\n` },
  { grammar: 'json', text: `{\n  "k": "v",\n  "n": -1.5e3,\n  "b": true,\n  "z": null\n}\n` },
  { grammar: 'shell', text: `#!/bin/bash\nset -e\nif [ -n "$FOO" ]; then\n  echo "\${BAR}"\nfi\n` },
  { grammar: 'yaml', text: `# c\nname: x\nlist:\n  - a\n  - "b"\nok: true\n` },
  { grammar: 'markdown', text: '# 标题\n\n正文 `code` 与 [链接](http://x)\n\n```js\nconst a = 1;\n```\n' },
  { grammar: 'plain', text: '任意\n内容\n\n末尾空行\n' },
];

describe('tokenize · 不吞字符（最重要的不变量）', () => {
  for (const sample of SAMPLES) {
    it(`${sample.grammar} 拼回原文`, () => {
      expect(rejoin(tokenize(sample.text, sample.grammar))).toBe(sample.text);
    });
  }

  it('空串产出单个空行，拼回仍是空串', () => {
    expect(rejoin(tokenize('', 'clike'))).toBe('');
  });

  it('只有换行时行数正确', () => {
    expect(tokenize('\n\n', 'clike')).toHaveLength(3);
  });

  it('含各种奇怪字符也不丢', () => {
    const weird = 'a\t→\u200b€\\n"未闭合\n下一行';
    expect(rejoin(tokenize(weird, 'clike'))).toBe(weird);
  });
});

// ==================== 跨行结构 ====================

describe('tokenize · 跨行结构（按行独立高亮必错的那些）', () => {
  it('块注释跨行：第二行仍然是 comment', () => {
    const lines = tokenize('a\n/* 开\n中\n关 */\nb', 'clike');
    expect(kindsOf(lines, 1)).toEqual(['comment']);
    expect(kindsOf(lines, 2)).toEqual(['comment']);
    expect(kindsOf(lines, 3)).toEqual(['comment']);
  });

  it('模板字符串跨行', () => {
    const lines = tokenize('const s = `第一行\n第二行`;', 'clike');
    expect(kindsOf(lines, 1)[0]).toBe('string');
  });

  it('python 三引号跨行', () => {
    const lines = tokenize('x = """a\nb"""', 'python');
    expect(kindsOf(lines, 1)[0]).toBe('string');
  });

  it('HTML 注释跨行', () => {
    const lines = tokenize('<p>x</p>\n<!-- a\nb -->', 'html');
    expect(kindsOf(lines, 2)[0]).toBe('comment');
  });

  it('未闭合的块注释吃到结尾，不抛也不丢', () => {
    const text = 'a\n/* 没关';
    const lines = tokenize(text, 'clike');
    expect(rejoin(lines)).toBe(text);
    expect(kindsOf(lines, 1)).toEqual(['comment']);
  });

  it('未闭合的字符串吃到行尾，不吞掉后面的行', () => {
    const text = 'a = "没关\nb = 1';
    const lines = tokenize(text, 'clike');
    expect(rejoin(lines)).toBe(text);
    expect(lines).toHaveLength(2);
  });
});

// ==================== 各语法的识别 ====================

describe('tokenize · 识别', () => {
  it('clike：关键字 / 字符串 / 注释 / 数字 / 函数名', () => {
    const lines = tokenize('const n = compute(0x1f); // c', 'clike');
    expect(textOfKind(lines, 'keyword')).toContain('const');
    expect(textOfKind(lines, 'number')).toContain('0x1f');
    expect(textOfKind(lines, 'func')).toContain('compute');
    expect(textOfKind(lines, 'comment')).toContain('// c');
  });

  /**
   * 关键字表只收 JS/TS 家族，不收 Rust/Go 的 `fn` / `use` / `match` 等 ——
   * 它们是常见 JS 标识符，误染比漏染更糟（见 `highlight.ts` 里的说明）。
   */
  it('常见 JS 标识符不被误染成关键字', () => {
    for (const name of ['fn', 'use', 'match', 'self', 'nil', 'go', 'func']) {
      const lines = tokenize(`const ${name} = 1;`, 'clike');
      expect(textOfKind(lines, 'keyword')).toEqual(['const']);
    }
  });

  it('html：标签名与属性名分开着色', () => {
    const lines = tokenize('<div class="a">x</div>', 'html');
    expect(textOfKind(lines, 'tag')).toContain('<div');
    expect(textOfKind(lines, 'attr')).toContain('class');
    expect(textOfKind(lines, 'string')).toContain('"a"');
  });

  it('css：属性名与选择器分开着色', () => {
    const lines = tokenize('.a { color: red; }', 'css');
    expect(textOfKind(lines, 'tag')).toContain('.a');
    expect(textOfKind(lines, 'property')).toContain('color');
  });

  it('json：键与字符串值区分（键走 property）', () => {
    const lines = tokenize('{"k":"v"}', 'json');
    expect(textOfKind(lines, 'property')).toEqual(['"k"']);
    expect(textOfKind(lines, 'string')).toEqual(['"v"']);
  });

  it('shell：变量与短横线参数', () => {
    const lines = tokenize('cp -r $SRC dst', 'shell');
    expect(textOfKind(lines, 'attr')).toContain('-r');
    expect(textOfKind(lines, 'property')).toContain('$SRC');
  });

  it('shell：双引号内的变量整体算字符串（不做嵌套着色）', () => {
    const lines = tokenize('echo "$SRC"', 'shell');
    expect(textOfKind(lines, 'string')).toContain('"$SRC"');
    expect(textOfKind(lines, 'property')).toEqual([]);
  });

  it('markdown：标题与围栏代码', () => {
    const lines = tokenize('# 标题\n```js\na\n```', 'markdown');
    expect(textOfKind(lines, 'keyword')).toContain('# 标题');
    expect(textOfKind(lines, 'string').join('')).toContain('```js');
  });

  it('plain 语法不着色，整段都是 plain', () => {
    const lines = tokenize('const x = 1;', 'plain');
    expect(kindsOf(lines, 0)).toEqual(['plain']);
  });
});

// ==================== 扩展名映射 ====================

describe('grammarForPath', () => {
  it('常见扩展名', () => {
    expect(grammarForPath('/a/b.ts')).toBe('clike');
    expect(grammarForPath('/a/b.tsx')).toBe('clike');
    expect(grammarForPath('/a/b.py')).toBe('python');
    expect(grammarForPath('/a/index.html')).toBe('html');
    expect(grammarForPath('/a/x.module.css')).toBe('css');
    expect(grammarForPath('/a/pkg.json')).toBe('json');
    expect(grammarForPath('/a/run.sh')).toBe('shell');
    expect(grammarForPath('/a/c.yml')).toBe('yaml');
    expect(grammarForPath('/a/README.md')).toBe('markdown');
  });

  it('大小写不敏感', () => {
    expect(grammarForPath('/a/B.TS')).toBe('clike');
    expect(grammarForPath('/a/Index.HTML')).toBe('html');
  });

  it('Windows 分隔符', () => {
    expect(grammarForPath('C:\\x\\y.json')).toBe('json');
  });

  it('无扩展名的约定文件名', () => {
    expect(grammarForPath('/a/Dockerfile')).toBe('shell');
    expect(grammarForPath('/a/Makefile')).toBe('shell');
    expect(grammarForPath('/home/me/.zshrc')).toBe('shell');
  });

  it('认不出的一律 plain（不猜）', () => {
    expect(grammarForPath('/a/b.weird')).toBe('plain');
    expect(grammarForPath('/a/noext')).toBe('plain');
    expect(grammarForPath('')).toBe('plain');
  });
});

// ==================== 行数闸门 ====================

describe('attachTokens · 行数闸门', () => {
  it('正常规模挂上 token', () => {
    const lines = [{ kind: 'add', text: 'const a = 1;', newNo: 1 }];
    const out = attachTokens(lines, { oldText: '', newText: 'const a = 1;', grammar: 'clike' });
    expect(out[0]?.tokens?.some((token) => token.kind === 'keyword')).toBe(true);
  });

  it('plain 语法不挂 token', () => {
    const lines = [{ kind: 'add', text: 'x', newNo: 1 }];
    const out = attachTokens(lines, { oldText: '', newText: 'x', grammar: 'plain' });
    expect(out[0]?.tokens).toBeUndefined();
  });

  it('超过闸门整段不着色（不是截断一半）', () => {
    const count = MAX_HIGHLIGHT_LINES + 1;
    const text = Array.from({ length: count }, (_, i) => `const a${i} = 1;`).join('\n');
    const lines = Array.from({ length: count }, (_, i) => ({
      kind: 'add' as const, text: `const a${i} = 1;`, newNo: i + 1,
    }));
    const out = attachTokens(lines, { oldText: '', newText: text, grammar: 'clike' });
    expect(out.every((line) => line.tokens === undefined)).toBe(true);
  });

  it('删除行取旧侧 token，新增行取新侧', () => {
    const out = attachTokens(
      [
        { kind: 'remove', text: 'const a = 1;', oldNo: 1 },
        { kind: 'add', text: '// b', newNo: 1 },
      ],
      { oldText: 'const a = 1;', newText: '// b', grammar: 'clike' },
    );
    expect(out[0]?.tokens?.[0]?.kind).toBe('keyword');
    expect(out[1]?.tokens?.[0]?.kind).toBe('comment');
  });
});
