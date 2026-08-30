/**
 * 控制台新树的依赖禁令（57号 §9.2）。抽成常量是必需的：
 * ESLint 的 `no-restricted-imports` 在后置 override 中会**整条替换**前面的配置，
 * 所以模式隔离规则必须把这三条一并带上，否则 modes/ 下就失去了 antd 禁令。
 */
const CONSOLE_DEP_BANS = [
  { group: ['antd', 'antd/*'], message: 'Console 新树用原生 dialog/popover（57号 §3.2）' },
  /**
   * 画布只在 dock 模式存在（用户 2026-07-31 裁决恢复），封禁**只对 dock 放开** ——
   * 见下方 overrides 里 `modes/dock/canvas/**` 的例外。thread 侧继续禁：
   * 模式互不参照那条不能因为恢复画布而破掉。
   */
  { group: ['@xyflow/react', '@xyflow/react/*'], message: 'Console 新树只有 dock 模式有画布（57号 §2.1 + 2026-07-31 裁决）' },
  { group: ['framer-motion', 'framer-motion/*'], message: 'Console 新树用 CSS 动画（57号 §3.2）' },
];

module.exports = {
  root: true,
  env: {
    browser: true,
    es2020: true,
    node: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended',
    'eslint-config-prettier',
  ],
  ignorePatterns: ['dist', 'dist-electron', '.eslintrc.cjs', 'electron/piskiepilot/browser/lib/chrome-devtools-mcp'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: {
      jsx: true,
    },
  },
  plugins: ['react', 'react-hooks', 'react-refresh', '@typescript-eslint'],
  settings: {
    react: {
      version: 'detect',
    },
  },
  overrides: [
    {
      // 控制台渲染层只用平台能力（原生 dialog/popover/CSS 动画），不引入这三个依赖。
      // patterns 必需：paths 不拦子路径导入（如 antd/es/...）。
      files: ['src/features/console/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-imports': ['error', { patterns: CONSOLE_DEP_BANS }],
      },
    },
    {
      /**
       * 模式隔离与分层（57号 §2.3）—— **防回潮规则**。
       *
       * 第一版就是因为 thread(时名 codex)复用了 dock 形状的 `AgentPanel`，把 dock 的视觉语言
       * （2px 外框 / 4px 状态条 / 卡片式 cell）整块灌了进来。有了这三条，
       * 再有人（包括我）把某个模式的件塞进共享层给另一个模式用，lint 直接拦下。
       */
      files: ['src/features/console/modes/dock/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [
            ...CONSOLE_DEP_BANS,
            // 两种写法都要拦：`no-restricted-imports` 匹配的是**导入字符串**而非解析路径，
            // 同级相对导入（`../thread/x`）里并不含 `modes/`。
            {
              group: ['**/modes/thread/**', '**/thread/**', '**/thread'],
              message: 'dock 不得依赖 thread（57号 §2.3 模式互不参照）',
            },
          ],
        }],
      },
    },
    {
      /**
       * dock 的画布子树：**唯一**允许引 `@xyflow/react` 的地方
       * （用户 2026-07-31 裁决恢复画布形态）。antd / framer-motion 仍然禁 ——
       * 只放开画布引擎这一项，别顺带把其它封禁一起松掉。
       */
      files: ['src/features/console/modes/dock/canvas/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [
            ...CONSOLE_DEP_BANS.filter((ban) => !ban.group.includes('@xyflow/react')),
            {
              group: ['**/modes/thread/**', '**/thread/**', '**/thread'],
              message: 'dock 不得依赖 thread（57号 §2.3 模式互不参照）',
            },
          ],
        }],
      },
    },
    {
      files: ['src/features/console/modes/thread/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [
            ...CONSOLE_DEP_BANS,
            {
              group: ['**/modes/dock/**', '**/dock/**', '**/dock'],
              message: 'thread 不得依赖 dock（57号 §2.3 模式互不参照）',
            },
          ],
        }],
      },
    },
    {
      // 共享层不得反向依赖模式：否则"共享件"会被某个模式的形态污染
      files: ['src/features/console/+(content|chrome|data|shell)/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [
            ...CONSOLE_DEP_BANS,
            { group: ['**/modes/**'], message: '共享层不得依赖 modes/（会把模式形态带进共享件，57号 §2.3）' },
          ],
        }],
      },
    },
    {
      files: ['electron/tools/fs/**/*.tool.ts'],
      excludedFiles: [
        'electron/tools/fs/read.tool.ts',
        'electron/tools/fs/glob.tool.ts',
        'electron/tools/fs/grep.tool.ts',
        'electron/tools/fs/ls.tool.ts',
      ],
      rules: {
        'no-restricted-imports': ['error', {
          paths: ['fs', 'fs/promises', 'node:fs', 'node:fs/promises'],
        }],
      },
    },
  ],
  rules: {
    'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    'react/prop-types': 'off', // 使用 TypeScript 类型检查
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
  },
};
