import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';

vi.mock('@/components/content-links', () => ({
  LinkedMarkdown: ({ children }: { children: string }) => createElement('div', null, children),
}));

import type { TaskItem } from '../../../../../shared/types';
import { AgentActivityRow } from '../AgentActivityRow';
import { TaskList } from '../TaskList';

function task(id: string, status: TaskItem['status']): TaskItem {
  return {
    id,
    subject: `任务 ${id}`,
    description: `任务 ${id} 的详情`,
    status,
    owner: 'main',
    dependsOn: [],
  };
}

function render(items: readonly TaskItem[], scope: 'main' | 'worker' = 'main'): string {
  return renderToStaticMarkup(createElement(TaskList, {
    taskBoard: { taskSummary: '完成测试任务', items },
    scope,
    mainAgentId: 'main',
    agentId: 'main',
  }));
}

describe('TaskList', () => {
  it('renders the AICSS task states collapsed by default', () => {
    const html = render([
      task('pending', 'pending'),
      task('active', 'in_progress'),
      task('done', 'completed'),
    ]);

    expect(html).toContain('data-state="active"');
    expect(html).toContain('data-status="pending"');
    expect(html).toContain('data-status="in_progress"');
    expect(html).toContain('data-status="completed"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('inert=""');
    expect(html).toContain('1/3');
  });

  it('marks an entirely completed list and keeps plan access on the main list only', () => {
    const completed = [task('first', 'completed'), task('second', 'completed')];

    expect(render(completed)).toContain('data-state="completed"');
    expect(render(completed)).toContain('aria-label="查看计划正文"');
    expect(render(completed, 'worker')).not.toContain('aria-label="查看计划正文"');
  });

  it('reuses the Working text treatment for the active task', () => {
    const activityHtml = renderToStaticMarkup(createElement(AgentActivityRow, { activeStartedAt: 0 }));
    const taskHtml = render([task('active', 'in_progress')]);
    const activityClass = activityHtml.match(/<span class="([^"]+)">Working…<\/span>/)?.[1];
    const taskClasses = taskHtml.match(/<span class="([^"]+)">任务 active<\/span>/)?.[1]?.split(' ');

    expect(activityClass).toBeTruthy();
    expect(taskClasses).toContain(activityClass);
  });

  it('renders nothing when there are no tasks', () => {
    expect(render([])).toBe('');
  });
});
