import assert from 'node:assert/strict';
import { BrowserManager } from '../../dist-electron/electron/piskiepilot/browser/core/browser/browser-manager.js';
import { BrowserOperations } from '../../dist-electron/electron/piskiepilot/browser/core/browser/browser-operations.js';
import { typeText as typeBrowserCoreText } from '../../dist-electron/electron/piskiepilot/browser/skills/browser/index.js';

export function serveTextInputFixture(request, response) {
  if (!request.url?.startsWith('/text-input')) return false;
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html>
    <html><head><title>Text input fixture</title></head><body>
      <div id="editor" role="textbox" aria-label="Editor" contenteditable="true"
        style="white-space: pre-wrap">prefix old suffix</div>
      <output id="save-status">idle</output>
      <script>
        const editor = document.querySelector('#editor');
        const storageKey = 'editor-draft' + location.search;
        const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
        if (saved) {
          editor.innerHTML = saved.html;
          document.querySelector('#save-status').textContent = 'restored';
        }
        window.editorState = { text: editor.innerText, inputs: [], keys: [], beforeInputs: [] };
        editor.addEventListener('keydown', (event) => {
          window.editorState.keys.push(event.key);
        });
        editor.addEventListener('beforeinput', (event) => {
          window.editorState.beforeInputs.push(event.inputType);
        });
        editor.addEventListener('input', (event) => {
          window.editorState.text = editor.innerText;
          window.editorState.inputs.push({
            data: event.data, inputType: event.inputType,
            trusted: event.isTrusted, composing: event.isComposing,
          });
          localStorage.setItem(storageKey, JSON.stringify({
            html: editor.innerHTML, text: window.editorState.text,
          }));
          document.querySelector('#save-status').textContent = 'saved';
        });
      </script>
    </body></html>`);
  return true;
}

export async function verifyTextInput(browserId, generated, origin) {
  const inputs = [
    ['core', async (text) => {
      const output = await typeBrowserCoreText({ browserId, text });
      assert.match(output, /Successfully typed text\n\n## Page Snapshot/);
    }],
    ['sdk', async (text) => {
      assert.deepEqual(await generated.page.typeText(text), {
        url: `${origin}/text-input?api=sdk`,
        title: 'Text input fixture',
      });
    }],
  ];
  for (const [api, typeText] of inputs) {
    await generated.page.navigate(`${origin}/text-input?api=${api}`);
    await BrowserManager.runExclusive(browserId, async ({ automation }) => {
      await automation.getSelectedPage().evaluate(() => {
        const editor = document.querySelector('#editor');
        editor.focus();
        const range = document.createRange();
        range.setStart(editor.firstChild, 7);
        range.setEnd(editor.firstChild, 10);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      });
    });

    await typeText('中😀A');
    const replacement = await readManagedEditor(browserId);
    assertEditorText(replacement, 'prefix 中😀A suffix');
    assert.equal(replacement.status, 'saved');
    assert.deepEqual(replacement.application.keys, ['A']);
    assert.deepEqual(replacement.application.inputs.map((event) => event.data), ['中', '😀', 'A']);
    assert.ok(replacement.application.inputs.every((event) => event.trusted && !event.composing));

    await generated.page.press('Control+A');
    const paragraphs = '  第一段：这是虚构的花园观察记录，蓝色积木旁摆着纸风车😀。\n'
      + '第二段：小熊把彩色卡片排成圆圈，纸船绕过想象中的小岛，大家记录柔和的云朵与星光🙂。'.repeat(12)
      + '\n\n最后一段：所有故事与物品均为测试用的虚构内容，记录到此结束🌟。  ';
    await typeText(paragraphs);
    const multiline = await readManagedEditor(browserId);
    assertEditorParagraphs(multiline, paragraphs);
    assert.equal(multiline.application.keys.filter((key) => key === 'Enter').length, 3);
    assert.equal(
      multiline.application.beforeInputs.filter((type) => type === 'insertParagraph').length,
      3,
    );
    assert.ok(multiline.application.inputs.every((event) => event.trusted));

    await typeText('');
    assert.deepEqual(await readManagedEditor(browserId), multiline);
    await typeText(' ');
    const spaced = await readManagedEditor(browserId);
    assertEditorParagraphs(spaced, paragraphs + ' ');
    assert.equal(spaced.application.inputs.length, multiline.application.inputs.length + 1);

    await BrowserManager.runExclusive(browserId, async ({ automation }) => {
      await automation.getSelectedPage().evaluate(() => document.querySelector('#editor').blur());
    });
    await typeText('unfocused');
    assert.deepEqual(await readManagedEditor(browserId), spaced);

    await BrowserManager.runExclusive(browserId, (connection) =>
      BrowserOperations.navigateInSession(connection.automation, { type: 'reload' })
    );
    const restored = await readManagedEditor(browserId);
    assertEditorParagraphs(restored, paragraphs + ' ');
    assert.equal(restored.status, 'restored');
    assert.equal(restored.application.inputs.length, 0);
    mark(`${api}-type-text-selection-events-paragraphs-save-reload: `
      + `${Array.from(paragraphs).length} code points, `
      + `${multiline.application.inputs.length - replacement.application.inputs.length} input events, `
      + '3 Enter events');
  }
}

async function readManagedEditor(browserId) {
  return BrowserManager.runExclusive(browserId, ({ automation }) =>
    automation.getSelectedPage().evaluate(() => ({
      text: document.querySelector('#editor').innerText,
      paragraphs: Array.from(document.querySelector('#editor').childNodes, (node) => node.textContent),
      application: window.editorState,
      saved: JSON.parse(localStorage.getItem('editor-draft' + location.search)),
      status: document.querySelector('#save-status').textContent,
    }))
  );
}

function assertEditorText(observation, expected) {
  assert.equal(observation.text, expected, JSON.stringify(observation));
  assertEditorSaved(observation);
}

function assertEditorParagraphs(observation, expected) {
  // Enter creates block paragraphs; innerText can add layout newlines for an empty block.
  assert.deepEqual(observation.paragraphs, expected.split('\n'));
  assertEditorSaved(observation);
}

function assertEditorSaved(observation) {
  assert.equal(observation.application.text, observation.text);
  assert.equal(observation.saved.text, observation.text);
}

function mark(check) {
  process.stderr.write(`[browser-type-text-live] ${check}\n`);
}
