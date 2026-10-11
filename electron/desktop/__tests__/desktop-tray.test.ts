import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({
  execFileSync: vi.fn(() => ''),
}));

vi.mock('node:child_process', () => ({
  execFileSync: childProcess.execFileSync,
}));

const electron = vi.hoisted(() => {
  class FakeNativeImage {
    readonly resize = vi.fn(() => this);
    readonly toPNG = vi.fn(() => Buffer.from('icon'));
    readonly addRepresentation = vi.fn();
    readonly setTemplateImage = vi.fn();

    constructor(readonly source: string) {}
  }

  class FakeTray {
    static readonly instances: FakeTray[] = [];
    readonly setToolTip = vi.fn();
    readonly setContextMenu = vi.fn();
    readonly setImage = vi.fn();
    readonly setTitle = vi.fn();
    readonly on = vi.fn();
    readonly popUpContextMenu = vi.fn();
    readonly destroy = vi.fn();

    constructor(readonly icon: FakeNativeImage) {
      FakeTray.instances.push(this);
    }
  }

  const nativeThemeListeners = new Set<() => void>();
  const nativeTheme = {
    shouldUseDarkColorsForSystemIntegratedUI: false,
    on: vi.fn((event: string, listener: () => void) => {
      if (event === 'updated') nativeThemeListeners.add(listener);
    }),
    removeListener: vi.fn((event: string, listener: () => void) => {
      if (event === 'updated') nativeThemeListeners.delete(listener);
    }),
  };

  return {
    FakeNativeImage,
    FakeTray,
    buildFromTemplate: vi.fn(() => ({})),
    createEmpty: vi.fn(() => new FakeNativeImage('empty')),
    createFromPath: vi.fn((source: string) => new FakeNativeImage(source)),
    nativeTheme,
    emitNativeThemeUpdated: () => {
      for (const listener of nativeThemeListeners) listener();
    },
    resetNativeTheme: () => {
      nativeTheme.shouldUseDarkColorsForSystemIntegratedUI = false;
      nativeThemeListeners.clear();
    },
  };
});

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: electron.buildFromTemplate },
  Tray: electron.FakeTray,
  nativeImage: {
    createEmpty: electron.createEmpty,
    createFromPath: electron.createFromPath,
  },
  nativeTheme: electron.nativeTheme,
}));

import type { AgentControlState, ChildControlState } from '../../../shared/types/agent-control.js';
import { createAgentObservations } from '../../agent/observations.js';
import { AgentActivityTracker } from '../../agent/run-metrics.js';
import { DesktopTray, type DesktopTrayOptions } from '../desktop-tray.js';

function registryOutput(systemUsesLightTheme: 0 | 1): string {
  return [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
    `    SystemUsesLightTheme    REG_DWORD    0x${systemUsesLightTheme}`,
  ].join('\r\n');
}

beforeEach(() => {
  electron.FakeTray.instances.length = 0;
  electron.resetNativeTheme();
  vi.clearAllMocks();
  childProcess.execFileSync.mockReset();
  childProcess.execFileSync.mockReturnValue(registryOutput(0));
});

function fixture(
  platform: NodeJS.Platform = 'linux',
  observations?: DesktopTrayOptions['observations'],
): DesktopTray {
  const releaseControlStates = vi.fn();
  const releaseRuntimes = vi.fn();
  return new DesktopTray({
    platform,
    lightGlyphPath: '/app/tray-glyph-light.png',
    darkGlyphPath: '/app/tray-glyph-dark.png',
    observations: observations ?? ({
      controlStateChanges: { subscribe: vi.fn(() => releaseControlStates) },
      runtimeReleases: { subscribe: vi.fn(() => releaseRuntimes) },
    } as never),
    onSummon: vi.fn(),
    onQuit: vi.fn(),
  });
}

describe('DesktopTray platform icons', () => {
  it('uses the light monochrome glyph on Linux', () => {
    const tray = fixture('linux');
    tray.start();
    const nativeTray = electron.FakeTray.instances[0]!;

    expect(nativeTray.icon.source).toBe('/app/tray-glyph-light.png');
    expect(electron.nativeTheme.on).not.toHaveBeenCalled();
    tray.dispose();
  });

  it('uses the Windows system theme when Electron initially reports the app theme', () => {
    vi.useFakeTimers();
    let tray: DesktopTray | undefined;
    try {
      tray = fixture('win32');
      tray.start();
      const nativeTray = electron.FakeTray.instances[0]!;
      const source = electron.createFromPath.mock.results[0]!.value as InstanceType<
        typeof electron.FakeNativeImage
      >;

      expect(electron.createFromPath).toHaveBeenLastCalledWith('/app/tray-glyph-light.png');
      expect(childProcess.execFileSync).toHaveBeenCalledWith(
        'reg.exe',
        [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
          '/v',
          'SystemUsesLightTheme',
        ],
        { encoding: 'utf8', timeout: 1000, windowsHide: true },
      );
      expect(source.resize).toHaveBeenNthCalledWith(1, { width: 16, height: 16, quality: 'best' });
      expect(source.resize).toHaveBeenNthCalledWith(2, { width: 20, height: 20, quality: 'best' });
      expect(source.resize).toHaveBeenNthCalledWith(3, { width: 24, height: 24, quality: 'best' });
      expect(source.resize).toHaveBeenNthCalledWith(4, { width: 32, height: 32, quality: 'best' });
      expect(nativeTray.icon.addRepresentation).toHaveBeenCalledTimes(4);
      expect(nativeTray.icon.addRepresentation).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ scaleFactor: 1 }),
      );
      expect(nativeTray.icon.addRepresentation).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ scaleFactor: 1.25 }),
      );
      expect(nativeTray.icon.addRepresentation).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ scaleFactor: 1.5 }),
      );
      expect(nativeTray.icon.addRepresentation).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({ scaleFactor: 2 }),
      );
      expect(electron.nativeTheme.on).toHaveBeenCalledWith('updated', expect.any(Function));

      childProcess.execFileSync.mockReturnValue(registryOutput(1));
      electron.emitNativeThemeUpdated();
      expect(nativeTray.setImage).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);

      expect(electron.createFromPath).toHaveBeenLastCalledWith('/app/tray-glyph-dark.png');
      const updatedIcon = nativeTray.setImage.mock.calls[0]![0] as InstanceType<
        typeof electron.FakeNativeImage
      >;
      expect(updatedIcon.addRepresentation).toHaveBeenCalledTimes(4);
      tray.dispose();
      tray = undefined;
      expect(electron.nativeTheme.removeListener).toHaveBeenCalledWith('updated', expect.any(Function));
    } finally {
      tray?.dispose();
      vi.useRealTimers();
    }
  });

  it('falls back to Electron nativeTheme when the Windows registry query fails', () => {
    childProcess.execFileSync.mockImplementation(() => {
      throw new Error('registry unavailable');
    });
    electron.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI = true;
    const tray = fixture('win32');
    tray.start();

    expect(electron.createFromPath).toHaveBeenLastCalledWith('/app/tray-glyph-light.png');
    tray.dispose();
  });

  it('marks the macOS glyph as a template image', () => {
    const tray = fixture('darwin');
    tray.start();
    const nativeTray = electron.FakeTray.instances[0]!;

    expect(electron.createFromPath).toHaveBeenCalledWith('/app/tray-glyph-light.png');
    expect(nativeTray.icon.setTemplateImage).toHaveBeenCalledWith(true);
    expect(nativeTray.icon.addRepresentation).toHaveBeenCalledTimes(2);
    expect(electron.nativeTheme.on).not.toHaveBeenCalled();
    tray.dispose();
  });
});

function sampleTracker(
  ...samples: Array<{ durationMs?: number; outputTokens?: number }>
): AgentActivityTracker {
  const tracker = new AgentActivityTracker();
  samples.forEach((sample, index) => tracker.aiCompleted({
    version: 1,
    requestId: `request-${index}`,
    runId: `run-${index}`,
    model: 'example::model',
    stopReason: 'end_turn',
    latencyMs: (sample.durationMs ?? 100) + 1_000,
    attemptDurationMs: sample.durationMs,
    usage: { outputTokens: sample.outputTokens },
  }));
  return tracker;
}

function controlState(
  agentId: string,
  tracker: AgentActivityTracker,
  overrides: Partial<AgentControlState> = {},
): AgentControlState {
  return {
    ...tracker.snapshot(),
    agentId,
    phase: 'thinking',
    currentModel: 'example::model',
    reasoningOverride: { kind: 'provider-default' },
    approvalMode: 'auto',
    modeId: 'normal',
    pendingEvents: [],
    conversationLength: 0,
    children: [],
    agentSpec: 'example',
    runConfig: { name: 'Example run', description: '', promptTemplate: '' },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function childState(
  tracker: AgentActivityTracker,
  phase: ChildControlState['phase'] = 'waiting',
): ChildControlState {
  return {
    ...tracker.snapshot(),
    id: 'example-child',
    phase,
    type: 'example',
    subject: 'Example task',
    browserReady: false,
    currentModel: 'example::model',
    approvalMode: 'auto',
    reasoningOverride: { kind: 'provider-default' },
    pendingEvents: [],
    conversationLength: 0,
  };
}

describe('DesktopTray output throughput observations', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(['linux', 'darwin'] as const)('weights busy main/child totals through $0 telemetry and excludes idle sessions', (platform) => {
    const observations = createAgentObservations();
    const tray = fixture(platform, observations.source);
    tray.start();
    try {
      const nativeTray = electron.FakeTray.instances[0]!;
      const main = controlState('example-main', sampleTracker({ durationMs: 100, outputTokens: 20 }), {
        children: [childState(sampleTracker({ durationMs: 900, outputTokens: 80 }))],
      });
      const other = controlState('example-other', sampleTracker({ durationMs: 2_000, outputTokens: 400 }));
      const idle = controlState('example-idle', sampleTracker({ durationMs: 1, outputTokens: 999 }), { phase: 'waiting' });
      for (const state of [main, other, idle]) {
        observations.publisher.controlStateChanged({ agentId: state.agentId, state });
      }
      vi.advanceTimersByTime(1_000);

      expect(nativeTray.setToolTip).toHaveBeenLastCalledWith('Piskie · 输出平均吞吐 167/s · 总消耗 1.5K');
      if (platform === 'darwin') {
        expect(nativeTray.setTitle).toHaveBeenLastCalledWith('167/s', { fontType: 'monospacedDigit' });
      }

      observations.publisher.runtimeReleased({ agentId: other.agentId, reason: 'stopped' });
      vi.advanceTimersByTime(1_000);
      expect(nativeTray.setToolTip).toHaveBeenLastCalledWith('Piskie · 输出平均吞吐 100/s · 总消耗 1.5K');
    } finally {
      tray.dispose();
    }
  });

  it('uses complete child samples when a busy child belongs to a root with no settled requests', () => {
    const observations = createAgentObservations();
    const tray = fixture('linux', observations.source);
    tray.start();
    try {
      const state = controlState('example-main', sampleTracker(), {
        phase: 'waiting',
        children: [childState(sampleTracker({ durationMs: 85, outputTokens: 3 }), 'thinking')],
      });
      observations.publisher.controlStateChanged({ agentId: state.agentId, state });
      vi.advanceTimersByTime(1_000);

      expect(electron.FakeTray.instances[0]!.setToolTip)
        .toHaveBeenLastCalledWith('Piskie · 输出平均吞吐 35/s · 总消耗 3');
    } finally {
      tray.dispose();
    }
  });

  it.each(['none', 'partial'] as const)('keeps $0 child coverage unknown alongside complete main samples', (coverage) => {
    const observations = createAgentObservations();
    const tray = fixture('darwin', observations.source);
    tray.start();
    try {
      const incomplete = coverage === 'none'
        ? sampleTracker({ outputTokens: 10 })
        : sampleTracker({ durationMs: 100, outputTokens: 10 }, { durationMs: 100 });
      const state = controlState('example-main', sampleTracker({ durationMs: 100, outputTokens: 20 }), {
        children: [childState(incomplete)],
      });
      observations.publisher.controlStateChanged({ agentId: state.agentId, state });
      vi.advanceTimersByTime(1_000);

      const nativeTray = electron.FakeTray.instances[0]!;
      expect(nativeTray.setToolTip).toHaveBeenLastCalledWith('Piskie · 输出平均吞吐 —/s · 总消耗 30');
      expect(nativeTray.setTitle).toHaveBeenLastCalledWith('—/s', { fontType: 'monospacedDigit' });
    } finally {
      tray.dispose();
    }
  });

  it.each([
    { name: 'zero duration', samples: [{ durationMs: 0, outputTokens: 3 }], rate: '—/s', total: '3' },
    { name: 'measured zero output', samples: [{ durationMs: 100, outputTokens: 0 }], rate: '0/s', total: '0' },
    { name: 'no settled samples', samples: [], rate: '—/s', total: '0' },
  ])('renders $name consistently in telemetry', ({ samples, rate, total }) => {
    const observations = createAgentObservations();
    const tray = fixture('linux', observations.source);
    tray.start();
    try {
      const state = controlState('example-main', sampleTracker(...samples));
      observations.publisher.controlStateChanged({ agentId: state.agentId, state });
      vi.advanceTimersByTime(1_000);

      expect(electron.FakeTray.instances[0]!.setToolTip)
        .toHaveBeenLastCalledWith(`Piskie · 输出平均吞吐 ${rate} · 总消耗 ${total}`);
    } finally {
      tray.dispose();
    }
  });
});
