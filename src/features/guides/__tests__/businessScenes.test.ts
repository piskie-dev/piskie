import { createInstance } from 'i18next';
import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import zh from '../../../i18n/locales/zh-CN';
import en from '../../../i18n/locales/en-US';
import { GUIDE_IDS } from '../catalog';
import { WorkflowFrame } from '../WorkflowScene';
import { PlanModeFrame } from '../PlanModeScene';
import { ForgeSheet } from '../../envstudio/sheets/ForgeSheet';
import studio from '../../envstudio/studio.module.css';
import agent from '../../agents/agent-management.module.css';
import picker from '../../agents/worker-model-dialog.module.css';

describe('read-only business scenes', () => {
  it('opens the browser menu after clicking the trigger and closes it after selecting an environment', () => {
    const shots = [21349, 21700, 22949, 23200].map(elapsed => new JSDOM(renderToStaticMarkup(
      createElement(WorkflowFrame, { id: 'browser', elapsed }),
    )));
    try {
      const [beforeOpen, opened, beforePick, picked] = shots.map(shot => shot.window.document) as [Document, Document, Document, Document];
      expect(beforeOpen.querySelector('[data-guide-target="browser-option"]')).toBeNull();
      for (const document of [opened, beforePick]) {
        expect(document.querySelector('[data-guide-target="browser-option"]')).not.toBeNull();
        expect(document.querySelector('[data-guide-target="browser-trigger"] [data-tone="blue"]')).toBeNull();
      }
      expect(picked.querySelector('[data-guide-target="browser-option"]')).toBeNull();
      expect(picked.querySelector('[data-guide-target="browser-trigger"] [data-tone="blue"]')?.textContent)
        .toContain(zh.guides.workflows.browser.name);
    } finally { shots.forEach(shot => shot.window.close()); }
  });

  it('shows the first automatic run before a later template launch starts a separate run', () => {
    const shots = [16500, 19500, 25500, 31500].map(elapsed => new JSDOM(renderToStaticMarkup(
      createElement(WorkflowFrame, { id: 'templates', elapsed }),
    )));
    try {
      const [creating, firstRun, later, repeatedRun] = shots.map(shot => shot.window.document) as [Document, Document, Document, Document];
      expect(creating.querySelector('[data-demo-target="true"]')?.textContent).toContain(zh.console.createAndRun);
      expect(firstRun.querySelector('[data-guide-run="initial"]')?.textContent).toContain(zh.guides.workflows.templates.firstRunHint);
      expect(firstRun.querySelector('[data-demo-target="true"]')).toBeNull();
      expect(later.body.textContent).toContain(zh.guides.workflows.templates.laterReuseHint);
      expect(later.querySelector('[data-demo-target="true"]')?.textContent).toContain(zh.guides.workflows.templates.name);
      expect(repeatedRun.querySelector('[data-guide-run="repeat"]')?.textContent).toContain(zh.guides.workflows.templates.reuseRunHint);
      expect(repeatedRun.querySelector('[data-demo-target="true"]')).toBeNull();
      for (const document of [firstRun, repeatedRun]) {
        expect(document.body.textContent).toContain(zh.guides.workflows.templates.value2);
      }
    } finally { shots.forEach(shot => shot.window.close()); }
  });

  it('reveals the model field before opening the picker, then returns with defaults before editing and saving', () => {
    const shot = (elapsed: number) => new JSDOM(renderToStaticMarkup(
      createElement(WorkflowFrame, { id: 'agents', elapsed }),
    ));
    const inherited = shot(2000);
    const fixed = shot(4000);
    const beforeOpen = shot(6149);
    const opened = shot(6500);
    const beforePick = shot(8649);
    const picked = shot(9000);
    const configured = shot(11500);
    const beforeSave = shot(13649);
    const saved = shot(14000);
    const ending = shot(14999);
    try {
      expect(inherited.window.document.querySelector(`.${agent.strategy}[aria-pressed="true"]`)?.textContent)
        .toContain('继承父 Agent');
      for (const frame of [fixed, beforeOpen]) {
        const document = frame.window.document;
        expect(document.querySelector(`.${agent.strategy}[aria-pressed="true"]`)?.textContent).toContain('指定模型');
        expect(document.querySelector(`.${agent.modelSelect} strong`)?.textContent).toBe('请选择模型');
        expect(document.querySelector(`.${picker.model}`)).toBeNull();
        expect(document.querySelector(`.${agent.reasoningOptions}`)).toBeNull();
        expect(document.querySelector(`.${agent.footer} .${agent.primary}`)?.hasAttribute('disabled')).toBe(true);
      }
      for (const frame of [opened, beforePick]) {
        expect(frame.window.document.querySelector(`.${picker.model}`)?.textContent).toContain('Claude Sonnet 4.6');
      }
      expect(picked.window.document.querySelector(`.${picker.model}`)).toBeNull();
      expect(picked.window.document.querySelector(`.${agent.modelSelect} strong`)?.textContent).toBe('Claude Sonnet 4.6');
      expect(picked.window.document.querySelector(`.${agent.reasoningOptions} [aria-pressed="true"]`)?.textContent).toBe('中');
      expect(configured.window.document.querySelector(`.${agent.reasoningOptions} [aria-pressed="true"]`)?.textContent)
        .toBe('高');
      expect(configured.window.document.querySelector(`.${agent.footer} .${agent.primary}`)?.hasAttribute('disabled'))
        .toBe(false);
      expect(beforeSave.window.document.querySelector(`.${agent.footer} .${agent.primary}`)?.hasAttribute('disabled')).toBe(false);
      expect(saved.window.document.querySelector(`.${agent.footer} .${agent.primary}`)?.hasAttribute('disabled'))
        .toBe(true);
      expect(saved.window.document.querySelector(`.${agent.footer}`)?.textContent).toContain('已保存');
      expect(ending.window.document.querySelector(`.${agent.footer}`)?.textContent).toContain('已保存');
    } finally {
      for (const frame of [inherited, fixed, beforeOpen, opened, beforePick, picked, configured, beforeSave, saved, ending]) frame.window.close();
    }
  });

  it('covers every live creation field before demonstrating create, start and binding', () => {
    const fields = (markup: string) => {
      const dom = new JSDOM(markup);
      try {
        return [...dom.window.document.querySelectorAll(`.${studio.field}`)].map(field => {
          for (const input of field.querySelectorAll('input')) input.removeAttribute('value');
          for (const input of field.querySelectorAll('textarea')) input.textContent = '';
          return field.outerHTML;
        });
      } finally { dom.window.close(); }
    };
    const live = renderToStaticMarkup(createElement(ForgeSheet, {
      env: null, proxies: [], kernelBuild: null, onClose: () => {}, onSaved: () => {},
    }));
    const shots = [3000, 4500, 7000, 10500].map(elapsed =>
      renderToStaticMarkup(createElement(WorkflowFrame, { id: 'browser', elapsed })),
    );
    for (const shot of shots) expect(fields(shot)).toEqual(fields(live));
    expect(fields(live)).toHaveLength(8);
    for (const shot of shots.slice(0, 3)) expect(shot).not.toContain('data-demo-target="true"');
    expect(shots[3]).toContain('data-demo-target="true"');
    expect(renderToStaticMarkup(createElement(WorkflowFrame, { id: 'browser', elapsed: 14000 })))
      .toContain('data-guide-source="ProgramMonitor"');
    expect(renderToStaticMarkup(createElement(WorkflowFrame, { id: 'browser', elapsed: 24500 })))
      .toContain('data-guide-source="WelcomeComposer/BrowserEnvironmentBindingPicker"');
  });

  it.each(['zh-CN', 'en-US'])(
    'renders every shot with translated business controls (%s)',
    async (language) => {
      const missing: string[] = [];
      const i18n = createInstance();
      await i18n.init({
        lng: language,
        fallbackLng: false,
        resources: { 'zh-CN': { translation: zh }, 'en-US': { translation: en } },
        saveMissing: true,
        missingKeyHandler: (_languages, _namespace, key) => {
          missing.push(key);
        },
        interpolation: { escapeValue: false },
      });
      for (const id of GUIDE_IDS) {
        const times = [1200, 3500, 5500, 7200, 9500, 11500, 13200, 17500, 19500, 23500];
        if (id === 'browser' || id === 'templates') times.push(27500, 29500, 33500, 35500);
        if (id === 'browser') times.push(3200, 5200, 7800, 21349, 21700, 22949, 26149);
        if (id === 'agents') times.push(...[0, 1, 2, 3, 4, 5].flatMap(phase => [200, 1149, 1500].map(time => phase * 2500 + time)), 14999);
        for (const elapsed of times) {
          const frame =
            id === 'getting-started'
              ? createElement(PlanModeFrame, { elapsed })
              : createElement(WorkflowFrame, { id, elapsed });
          const markup = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, frame));
          expect(markup, `${id} ${elapsed}`).toContain('data-guide-source=');
          expect(markup, `${id} ${elapsed}`).not.toMatch(/<video|<iframe|\{\{/);
          expect(markup, `${id} ${elapsed}`).not.toContain('undefined');
        }
      }
      expect([...new Set(missing)]).toEqual([]);
    }
  );
});
