import { appLog } from '../logging/app-log.js';
import { createUuid } from '@shared/utils/identifiers.js';
import type {
  AgentIncident,
  AgentIncidentChange,
  AgentTarget,
  ReportAgentIncidentInput,
} from '@shared/types/index.js';
import { createChangeChannel, type ChangeSource } from '../../core/change-channel.js';

const INCIDENT_MESSAGES: Record<string, { message: string; suggestions: string[] }> = {
  rate_limit: {
    message: 'AI 服务请求过于频繁，正在自动等待...',
    suggestions: ['系统会自动重试', '如长时间未恢复可切换模型'],
  },
  timeout: {
    message: 'AI 请求超时，正在重试...',
    suggestions: ['网络可能不稳定', '复杂任务需要更长时间'],
  },
  network: {
    message: '网络连接异常',
    suggestions: ['请检查网络连接', '如使用代理请确认代理可用'],
  },
  api_error: {
    message: 'AI API 调用失败',
    suggestions: ['请检查 API 配置', '可能是服务暂时不可用'],
  },
  unknown: {
    message: '发生未知错误',
    suggestions: ['请查看详细日志', '如持续出现请联系支持'],
  },
  browser_crash: {
    message: '浏览器进程崩溃',
    suggestions: ['系统会尝试重启浏览器', '如持续崩溃请检查内存使用'],
  },
  page_load_failed: {
    message: '页面加载失败',
    suggestions: ['请检查网络连接', '目标网站可能暂时不可用'],
  },
  element_not_found: {
    message: '页面元素未找到',
    suggestions: ['页面结构可能已变化', 'Skill 可能需要更新'],
  },
  tool_timeout: {
    message: '工具执行超时',
    suggestions: ['操作可能需要更长时间', '请检查网络状况'],
  },
  tool_failed: {
    message: '工具执行失败',
    suggestions: ['请查看详细错误信息', '可能需要手动介入'],
  },
  service_unavailable: {
    message: '服务暂时不可用',
    suggestions: ['请稍后重试', '如持续出现请检查系统状态'],
  },
};

const MAX_INCIDENTS = 100;

export class AgentIncidentStore {
  private readonly incidents = new Map<string, AgentIncident>();
  private readonly changeChannel = createChangeChannel<AgentIncidentChange>({
    onSubscriberError: (error) =>
      appLog.error({
        event: 'observability.agent_incident.publish.failed',
        message: 'Agent incident publication failed',
        context: { scope: 'observability.agent_incident' },
        error,
      }),
  });

  readonly changes: ChangeSource<AgentIncidentChange> = this.changeChannel.source;

  raise(input: ReportAgentIncidentInput): AgentIncident {
    const incident = materializeIncident(input);
    this.incidents.set(incident.id, incident);
    for (const removed of this.pruneOldIncidents()) {
      this.publish({ type: 'removed', incident: removed });
    }
    this.publish({ type: 'added', incident });
    return incident;
  }

  recover(target: AgentTarget): void {
    const recoveredAt = new Date();
    for (const incident of this.incidents.values()) {
      if (incident.autoRecovered || !sameTarget(incident.source, target)) continue;
      incident.autoRecovered = true;
      incident.recoveredAt = recoveredAt;
      this.publish({ type: 'updated', incident });
    }
  }

  dismiss(id: string): boolean {
    const incident = this.incidents.get(id);
    return incident === undefined ? false : this.removeIncident(id, incident);
  }

  clearAgent(agentId: string): void {
    for (const incident of [...this.incidents.values()]) {
      if (incident.source.agentId !== agentId) continue;
      this.incidents.delete(incident.id);
      this.publish({ type: 'removed', incident });
    }
  }

  clearAll(): void {
    const incidents = [...this.incidents.values()];
    this.incidents.clear();
    this.publish({ type: 'cleared', incidents });
  }

  snapshot(): AgentIncident[] {
    return [...this.incidents.values()].sort(
      (left, right) => right.timestamp.getTime() - left.timestamp.getTime()
    );
  }

  destroy(): void {
    this.incidents.clear();
  }

  private publish(change: AgentIncidentChange): void {
    this.changeChannel.sink.publish(change);
  }

  private removeIncident(id: string, incident: AgentIncident): true {
    this.incidents.delete(id);
    this.publish({ type: 'removed', incident });
    return true;
  }

  private pruneOldIncidents(): AgentIncident[] {
    if (this.incidents.size <= MAX_INCIDENTS) return [];
    const sorted = [...this.incidents.values()].sort(
      (left, right) => left.timestamp.getTime() - right.timestamp.getTime()
    );
    const evicted = sorted.slice(0, this.incidents.size - MAX_INCIDENTS);
    for (const incident of evicted) this.incidents.delete(incident.id);
    return evicted;
  }
}

function materializeIncident(input: ReportAgentIncidentInput): AgentIncident {
  const template = input.code ? INCIDENT_MESSAGES[input.code] : undefined;
  const identity = {
    id: createUuid(),
    timestamp: new Date(),
    severity: input.severity,
    category: input.category,
    source: input.source,
  };
  return Object.assign(identity, {
    message: input.message || template?.message || '发生错误',
    details: {
      originalError: input.originalError,
      code: input.code,
      context: input.context,
    },
    suggestions: template?.suggestions,
    autoRecovered: false,
  });
}

function sameTarget(left: AgentTarget, right: AgentTarget): boolean {
  return left.agentId === right.agentId && left.workerId === right.workerId;
}

export const agentIncidentStore = new AgentIncidentStore();
