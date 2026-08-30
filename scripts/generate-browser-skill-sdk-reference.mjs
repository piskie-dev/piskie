import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const projectRoot = path.resolve(import.meta.dirname, '..');
const sourcePath = path.join(
  projectRoot,
  'electron/piskiepilot/browser/runtime/generated-skill-browser.ts'
);
const outputPath = path.join(
  projectRoot,
  'electron/piskiepilot/browser/runtime/generated-skill-browser-reference.ts'
);
const source = await fs.readFile(sourcePath, 'utf8');
const file = ts.createSourceFile(
  sourcePath,
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
);

const declarations = [];
for (const statement of file.statements) {
  if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
    continue;
  const name = statement.name?.text;
  if (
    !name ||
    ![
      'BrowserSkillText',
      'BrowserSkillElementState',
      'BrowserSkillLocator',
      'BrowserPageObservation',
      'BrowserPageInfo',
      'BrowserNavigateOptions',
      'BrowserActionOptions',
      'BrowserWaitCondition',
      'BrowserWaitOptions',
      'BrowserTextExtraction',
      'BrowserListField',
      'BrowserListExtraction',
      'GeneratedSkillPage',
      'GeneratedBrowserSkillRuntime',
    ].includes(name)
  )
    continue;
  declarations.push(statement.getText(file).replace(/^export\s+/, ''));
}

if (!declarations.some((value) => value.startsWith('interface GeneratedSkillPage'))) {
  throw new Error('GeneratedSkillPage declaration not found');
}
if (!declarations.some((value) => value.startsWith('interface GeneratedBrowserSkillRuntime'))) {
  throw new Error('GeneratedBrowserSkillRuntime declaration not found');
}

const reference = `## Browser Skill SDK API Reference

This reference is the complete browser I/O surface available to generated \`skill.ts\` code. Business functions, private helpers, bounded branches, and data transformations are ordinary TypeScript; every browser read or side effect must use a method listed here.

### Allowed import and minimum module

\`\`\`ts
import { defineSkill, fail, ok, z, type BrowserSkillRuntime } from 'piskiepilot/core-skill'

type Page = BrowserSkillRuntime['page']

export default defineSkill({
  name: 'example-site',
  domain: 'browser',
  functions: {
    inspectPage: {
      description: 'Read the current page identity.',
      params: z.object({}),
      async run(_params, ctx) {
        const page = await ctx.browser.page.currentPage()
        return ok(JSON.stringify(page), { data: page })
      },
    },
  },
})
\`\`\`

Only imports explicitly shown as allowed by this reference may be used. Inside a Browser Skill function, \`ctx\` exposes only \`signal\`, \`log(message, data?)\`, and \`browser\`. The host binds the active browser, cancellation, and logging. Do not declare or pass browserId, taskId, agentId, or callId.

### Public types and methods

\`\`\`ts
${declarations.join('\n\n')}
\`\`\`

Locators are resolved from the current DOM for every operation. \`role\` means a standard HTML/ARIA DOM role; browser accessibility snapshot roles such as \`StaticText\` and snapshot UIDs are not runtime locators. Actions require an actionable DOM target, and locator waits require a visible target unless another state is explicitly requested. Locator arrays are ordered stable fallbacks. Never place browser snapshot UIDs in locators, parameters, source literals, or results. \`extractText\` and \`extractList\` accept structured requests only; they do not execute arbitrary page functions. Both default to \`state: 'visible'\`. For \`extractList\`, the selected state governs both item locators and nested field locators, so a hidden descendant field returns \`null\` under the default visible extraction. Action methods and \`waitFor\` throw on invalid input, cancellation, missing required elements, or timeout. \`extractText\` returns \`null\` when no element matches after its bounded wait, while \`extractList\` returns \`[]\` when no item matches; invalid requests, cancellation, and host failures still throw. Catch errors only when the business function can add useful stage facts or perform a bounded recovery.

Use \`click\` for ordinary activation. Use \`doubleClick\` only when the real website control requires a double-click; it is one intentional action, not a retry for a failed single click. Use \`hover\` when moving the pointer over an element is required to reveal or update content such as a menu or tooltip. When the hover result appears asynchronously, follow it with \`waitFor\` before extracting content or taking the next action.

After an action that may open or close a browser tab, call \`ctx.browser.listPages()\`, choose a \`pageIdx\` from that latest result, and call \`ctx.browser.selectPage(pageIdx)\` before continuing with \`ctx.browser.page\`. Page indices belong to the latest listing and must not be persisted as business identifiers.

### Small composition example

One business function can combine several SDK operations. This is a pattern, not a required function name or function count:

\`\`\`ts
searchOptions: {
  description: 'Submit a search and return stable option identifiers for a later selection.',
  params: z.object({ query: z.string().describe('User-visible search terms') }),
  async run({ query }, ctx) {
    const page = ctx.browser.page
    try {
      await page.fill([
        { css: '[data-testid="search-input"]' },
        { role: 'textbox', name: /search/i },
      ], query)
      await page.click({ role: 'button', name: /search/i })
      await page.waitFor({ locator: { css: '[data-result-item]' } })
      const options = await page.extractList({
        items: { css: '[data-result-item]' },
        fields: {
          optionId: { attribute: 'data-option-id' },
          summary: { text: 'self' },
        },
      })
      const result = { state: 'search-results', options }
      return ok(JSON.stringify(result), { data: result })
    } catch (error) {
      const current = await page.currentPage().catch(() => null)
      return fail(JSON.stringify({
        stage: 'search-options',
        page: current,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  },
}
\`\`\`

If a required browser operation is not expressible with the methods above, report a platform capability gap. Do not invent a method, import Puppeteer/CDP/BrowserManager, execute shell commands, read credentials, or add an arbitrary page-function escape hatch.`;
const output = `/**\n * Compact author reference generated from generated-skill-browser.ts public declarations.\n * Regenerate with scripts/generate-browser-skill-sdk-reference.mjs when that source changes.\n */\nexport const BROWSER_SKILL_SDK_REFERENCE = ${JSON.stringify(reference)};\n`;

if (process.argv.includes('--check')) {
  const current = await fs.readFile(outputPath, 'utf8');
  if (current !== output) {
    throw new Error('Browser Skill SDK Reference is stale; regenerate it');
  }
} else {
  await fs.writeFile(outputPath, output, 'utf8');
}
