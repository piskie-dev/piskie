/**
 * Browser Manager
 * 职责:
 * - 管理多个浏览器实例的生命周期
 * - 每个浏览器独立的互斥锁（解决并发问题）
 * - WebSocket 端点的持久化和恢复
 * - 线程安全的浏览器注册表
 */

import { getBrowsersDir, getUserDataRoot } from '@electron/piskiepilot/paths.js';
import type { CallerWindowConfig } from '@shared/types/index.js';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { BrowserAutomationSession } from '../session/browser-automation-session.js';
import { Mutex } from './shared-mutex.js';
import { ensureWebrtcPreferences } from './webrtc-preferences.js';
import { fingerprintBrowser, toFpUserConfig } from '../../fingerprint/runtime.js';
import type { BrowserLaunchSpec } from './browser-launch-spec.js';
import { WindowController } from './window-controller.js';
import debug from 'debug';
import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';

const logger = debug('piskiepilot:browser-manager');

/**
 * 浏览器实例信息
 */
interface BrowserInstance {
  automation: BrowserAutomationSession;
  browser: Browser;              // Puppeteer Browser实例
  mutex: Mutex;                  // 🔑 每个浏览器独立的锁
  kernelProfileId?: string;      // FingerprintBrowser 内部会话 ID
  launchGeneration?: string;
}

/**
 * 持久化配置
 */
interface PersistentConfig {
  wsEndpoint: string;
  userDataId?: string;       // 新增：userDataId 标识符
  userDataDir?: string;
  backgroundMode?: boolean;  // 后台模式：禁止节流
  pid?: number;
  launchGeneration?: string;
}

interface BrowserConnectionOptions {
  wsEndpoint?: string;
  userDataId?: string;
  userDataDir?: string;
  backgroundMode?: boolean;
  launchSpec?: BrowserLaunchSpec;
  launchGeneration?: string;
  callerWindow?: CallerWindowConfig;
}

interface BrowserLaunchOptions extends BrowserConnectionOptions {
  launchSpec: BrowserLaunchSpec;
}

export interface ConnectedBrowserSession {
  readonly automation: BrowserAutomationSession;
  readonly browser: Browser;
}

/**
 * 浏览器生命周期句柄—— instances 表的 value。
 * 登记的是所有权不是成品：getOrCreate 在第一个创建 await 前同步登记，
 * "创建中"的边界从此在登记表上可见，destroy 可经 terminate 覆盖创建全程。
 *
 * 并发契约六条：
 * 1. 同 ID 并发 getOrCreate 发现 handle → await ready，不把"存在"当"可用"；
 * 2. ready 失败按 handle 身份删条目；恢复失败则原子恢复断线前的所有权句柄；
 * 3. terminate 幂等：创建前/中/后调用返回同一 settlement；
 * 4. terminate 后同 ID 新建等旧 settlement 完成；
 * 5. has 不把 creating 当 ready（getReady 显式区分）；
 * 6. 创建超时也经 handle settle（超时 = ready reject，不是第四种 settle 来源）。
 */
interface BrowserHandle {
  /** 创建凭据：成品或创建失败（含创建超时、创建中被 terminate） */
  readonly ready: Promise<BrowserInstance>;
  /**
   * 边界终止：发起同步取引用直接关（不排队不等 mutex，簿记事后补）；
   * settle 来自 OS/库级事实（transport 关闭 ⇒ 在途 CDP 调用必然 reject）。
   */
  terminate(reason: string): Promise<void>;
  /** 成品且未被终止时返回实例；创建中/失败/终止中返回 undefined */
  getReady(): BrowserInstance | undefined;
  /**
   * 紧急兜底访问器：无论是否正在 terminate 都返回已消费成品——
   * terminate 挂住（close 永不 settle）恰是 PID 兜底的主场景，getReady 在
   * 该场景隐藏实例，emergencyKillAll 需经此触达 PID。
   */
  getConsumed(): BrowserInstance | undefined;
}

/** 创建超时：创建是有界操作，与操作期 protocolTimeout: 0 不冲突 */
const BROWSER_CREATE_TIMEOUT_MS = 60_000;

/** graceful close 期限：protocolTimeout: 0 下 browser.close() 无自带
 * 上限，CDP 卡死时永不 settle——期限后升级为 PID 级进程终止 */
const BROWSER_CLOSE_TIMEOUT_MS = 5_000;

function browserAbortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error('Browser operation was cancelled');
  error.name = 'AbortError';
  return error;
}

/**
 * 浏览器管理器
 */
export class BrowserManager {
  /** 生命周期句柄表：条目 = 所有权（含创建中），成品经 getReady() 取 */
  private static instances = new Map<string, BrowserHandle>();
  private static globalMutex = new Mutex(); // 🔒 串行化创建过程（终止路径不拿此锁——边界终止不排队）
  private static get persistDir(): string {
    return getBrowsersDir();
  }
  private static initialized = false;

  /**
   * 初始化管理器
   */
  private static async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await fs.mkdir(this.persistDir, { recursive: true });
    logger('Browser manager initialized, persist dir: %s', this.persistDir);
    this.initialized = true;
  }

  /**
   * 创建或连接到浏览器
   *
   * @param browserId 浏览器唯一ID
   * @param options 创建/连接选项
   * @returns 浏览器ID
   */
  static async getOrCreate(browserId: string, options?: BrowserLaunchOptions): Promise<string> {
    // 确保已初始化
    if (!this.initialized) {
      await this.initialize();
    }

    const persistedConfig = await this.readPersistedBrowserConfig(browserId);
    const effectiveUserDataId = options?.launchSpec.userDataId ?? persistedConfig?.userDataId;
    const needsRestart = Boolean(
      options?.launchSpec &&
      persistedConfig?.userDataId &&
      persistedConfig.userDataId !== effectiveUserDataId
    );

    // ========== 复用 / 终止旧世代 / 登记所有权 ==========
    for (;;) {
      const existing = this.instances.get(browserId);
      if (!existing) break;

      if (needsRestart) {
        // 契约 4：terminate 后同 ID 新建必须等旧 settlement 完成（失败即上抛，不在残留边界上新建）
        await existing.terminate('userDataId changed');
        continue;   // settlement 完成后条目已删，重查后登记新 handle
      }

      // 契约 1：存在 ≠ 可用——创建中等成品，创建失败对并发调用方可见（reject 上抛）
      const instance = await existing.ready;
      if (options?.launchSpec && instance.launchGeneration !== options.launchSpec.generation) {
        await existing.terminate('browser launch generation changed');
        continue;
      }
      if (existing.getReady()) {
        if (!instance.browser.connected) {
          await this.recoverDisconnected(browserId, existing, instance, effectiveUserDataId);
          return browserId;
        }
        logger('Browser %s already exists, reusing', browserId);
        return browserId;
      }
      // 成品已被 terminate 接管：等旧 settlement 后重查（幂等门闩返回同一 settlement）
      await existing.terminate('await prior termination');
    }

    // 登记所有权（同步 set，先于任何创建 await——"创建中"的边界从此可见）
    const handle = this.registerHandle(browserId, () =>
      this.createInstance(browserId, options, effectiveUserDataId, effectiveUserDataId ?? browserId)
    );
    await handle.ready;
    return browserId;
  }

  /**
   * 登记生命周期句柄（有界终止版）——三个 Promise 事实：
   * - rawCreation：底层真实创建 settlement，超时不结束它，所有权追踪到底
   * - consumerReady（对外 ready）：rawCreation 与创建超时的 race——超时只判负消费方
   * - termination：等 rawCreation 退出（有界，宽限一个创建超时级别）+ 关闭包括迟到
   *   成品在内的实例；关闭失败 = settlement reject、条目保留（半死边界在表上可见）
   * 条目寿命 = rawCreation ∪ termination；"消费方失败删条目"仅当两者皆已 settle。
   * 恢复连接可携带 fallbackOnFailure，失败后保留原断线实例的关闭权和重试入口。
   */
  private static registerHandle(
    browserId: string,
    create: () => Promise<BrowserInstance>,
    fallbackOnFailure?: BrowserHandle
  ): BrowserHandle {
    const state: {
      /** consumerReady 成功的成品（迟到成品不入此——它只归 termination 关闭） */
      consumedInstance?: BrowserInstance;
      terminateSettlement?: Promise<void>;
    } = {};

    // 事实 1：底层创建 settlement（失败在消费方/termination 处消费，此处仅防 unhandled）
    const rawCreation: Promise<BrowserInstance> = create();
    rawCreation.catch(() => {
      /* consumed by consumerReady / termination */
    });

    // 事实 2：消费方视角（契约 6：创建超时经 handle settle = ready reject）
    const consumerReady: Promise<BrowserInstance> = (async () => {
      const instance = await this.raceCreateTimeout(rawCreation, browserId);
      if (state.terminateSettlement) {
        // 创建期间被 terminate：实例交给 terminate 链关闭（它在等 rawCreation），
        // 对 getOrCreate 消费方呈现失败——被终止的实例不得当可用返回
        throw new Error(`Browser ${browserId} terminated during creation`);
      }
      state.consumedInstance = instance;
      return instance;
    })();

    const handle: BrowserHandle = {
      ready: consumerReady,
      getReady: () => (state.terminateSettlement ? undefined : state.consumedInstance),
      getConsumed: () => state.consumedInstance ?? fallbackOnFailure?.getConsumed(),
      terminate: (reason: string): Promise<void> => {
        // 契约 3：幂等——创建前/中/后调用返回同一 settlement（rejected 亦可反复消费）
        if (!state.terminateSettlement) {
          logger('Terminating browser %s (%s)', browserId, reason);
          state.terminateSettlement = (async () => {
            // 事实 3：等底层创建退出（有界）后关闭成品——含超时判负后的迟到成品；
            // rawCreation 宽限期内不 settle → 诚实 reject（无凭据，条目保留）
            const instance = await this.awaitRawCreationBounded(rawCreation, browserId);
            if (instance) {
              // 失败即上抛：settlement reject = 边界终止无凭据，条目保留
              await this.destroyInstance(browserId, instance);
            } else if (fallbackOnFailure) {
              await fallbackOnFailure.terminate(reason);
            }
            if (this.instances.get(browserId) === handle) {
              this.instances.delete(browserId);
            }
          })();
        }
        return state.terminateSettlement;
      },
    };

    // 契约 2（有界终止版）：消费方失败不直接删条目——先等 rawCreation settle：
    // 有迟到成品 → 经 termination 关闭（关闭失败 rejection 在 settlement 上可见，条目保留）；
    // 底层也失败 → 两事实皆 settle，条目退场（身份检查防误删新世代）
    consumerReady.catch(() => {
      void (async () => {
        const late = await rawCreation.then(
          (i) => i,
          () => undefined
        );
        if (state.terminateSettlement) return;   // terminate 已接管，删除责任归它
        if (late) {
          handle.terminate('late creation after consumer failure').catch(() => {
            // rejection 已在 termination settlement 上可见——此 catch 仅防 unhandledRejection
          });
          return;
        }
        if (this.instances.get(browserId) === handle) {
          if (fallbackOnFailure) {
            this.instances.set(browserId, fallbackOnFailure);
          } else {
            this.instances.delete(browserId);
          }
        }
      })();
    });

    this.instances.set(browserId, handle);
    return handle;
  }

  /** Replaces a disconnected transport with one persisted-endpoint connection attempt. */
  private static async recoverDisconnected(
    browserId: string,
    staleHandle: BrowserHandle,
    staleInstance: BrowserInstance,
    effectiveUserDataId: string | undefined
  ): Promise<BrowserInstance> {
    const persisted = await this.readPersistedBrowserConfig(browserId);
    if (!persisted?.wsEndpoint) {
      throw new Error(
        `Browser "${browserId}" disconnected and has no persisted endpoint for recovery.`
      );
    }

    const current = this.instances.get(browserId);
    if (current !== staleHandle) {
      if (!current) {
        throw new Error(`Browser "${browserId}" lost its lifecycle handle during recovery.`);
      }
      return current.ready;
    }

    logger('Recovering disconnected browser %s from %s', browserId, persisted.wsEndpoint);
    const recoveryOptions: BrowserConnectionOptions = {
      wsEndpoint: persisted.wsEndpoint,
      userDataId: persisted.userDataId,
      userDataDir: persisted.userDataDir,
      backgroundMode: persisted.backgroundMode,
      launchGeneration: persisted.launchGeneration ?? staleInstance.launchGeneration,
    };
    const recoveryHandle = this.registerHandle(
      browserId,
      () =>
        this.createInstance(
        browserId,
        recoveryOptions,
        persisted.userDataId ?? effectiveUserDataId,
          persisted.userDataId ?? effectiveUserDataId ?? browserId
      ),
      staleHandle
    );

    try {
      return await recoveryHandle.ready;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Browser "${browserId}" recovery failed: ${detail}`, { cause: error });
    }
  }

  /** 消费方超时 race（契约 6）：只判负消费方，不动 rawCreation 的所有权 */
  private static raceCreateTimeout(
    rawCreation: Promise<BrowserInstance>,
    browserId: string
  ): Promise<BrowserInstance> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(`Browser ${browserId} creation timed out after ${BROWSER_CREATE_TIMEOUT_MS}ms`)
        );
      }, BROWSER_CREATE_TIMEOUT_MS);
      rawCreation.then(
        (instance) => {
          clearTimeout(timer);
          resolve(instance);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  /**
   * termination 的有界等待：宽限一个创建超时级别；
   * rawCreation 失败 → 无实例可关（undefined）；超期不 settle → reject（诚实失败，
   * 可能存在进程残留——由 puppeteer 自身 launch 超时与应用退出兜底，用户定档）。
   */
  private static awaitRawCreationBounded(
    rawCreation: Promise<BrowserInstance>,
    browserId: string
  ): Promise<BrowserInstance | undefined> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Browser ${browserId} raw creation did not settle within termination grace (${BROWSER_CREATE_TIMEOUT_MS}ms) — possible process leak`
          )
        );
      }, BROWSER_CREATE_TIMEOUT_MS);
      rawCreation.then(
        (instance) => {
          clearTimeout(timer);
          resolve(instance);
        },
        () => {
          clearTimeout(timer);
          resolve(undefined);
        }
      );
    });
  }

  /**
   * 创建/连接浏览器实例。
   * globalMutex 只串行化创建过程；终止路径不拿此锁。
   */
  private static async createInstance(
    browserId: string,
    options: BrowserConnectionOptions | undefined,
    effectiveUserDataId: string | undefined,
    kernelProfileId: string
  ): Promise<BrowserInstance> {
    const guard = await this.globalMutex.acquire();
    let browser: Browser | undefined;
    let wsEndpoint: string | undefined;
    let kernelStarted = false;
    let activeKernelProfileId: string | undefined;
    let automation: BrowserAutomationSession | undefined;

    try {
      logger('Creating/connecting browser: %s', browserId);

      const launchSpec = options?.launchSpec;
      if (launchSpec) {
        if (launchSpec.browserId !== browserId) {
          throw new Error(
            `Browser launch spec ID mismatch: ${launchSpec.browserId} != ${browserId}`
          );
        }
        if (launchSpec.userDataId !== effectiveUserDataId) {
          throw new Error(
            `Browser launch spec userData mismatch: ${launchSpec.userDataId} != ${effectiveUserDataId}`
          );
        }
      }

      let connectionOptions = options;
      if (!launchSpec && !connectionOptions?.wsEndpoint) {
        const persistedConfig = await this.readPersistedBrowserConfig(browserId);
        if (persistedConfig?.wsEndpoint) {
          connectionOptions = {
            userDataId: persistedConfig.userDataId,
            userDataDir: persistedConfig.userDataDir,
            backgroundMode: persistedConfig.backgroundMode,
            launchGeneration: persistedConfig.launchGeneration,
            ...connectionOptions,
            wsEndpoint: persistedConfig.wsEndpoint,
          };
        }
      }

      if (connectionOptions?.wsEndpoint) {
        try {
          browser = await puppeteer.connect({
            browserWSEndpoint: connectionOptions.wsEndpoint,
            defaultViewport: null,
            protocolTimeout: 0,
          });
          wsEndpoint = connectionOptions.wsEndpoint || browser.wsEndpoint();
          if (fingerprintBrowser.has(kernelProfileId)) {
            activeKernelProfileId = kernelProfileId;
          }
          logger('Connected to existing browser: %s', wsEndpoint);
        } catch (error) {
          logger('Failed to connect to existing browser: %O', error);
          if (!launchSpec) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(
              `Could not reconnect browser "${browserId}" to its existing endpoint: ${detail}`,
              { cause: error }
            );
          }
          connectionOptions = {
            ...connectionOptions,
            wsEndpoint: undefined,
          };
        }
      }

      const shouldBackgroundMode = launchSpec
        ? launchSpec.backgroundMode
        : connectionOptions?.backgroundMode === true;
      let userDataDir = connectionOptions?.userDataDir;

      if (!browser) {
        if (!launchSpec) {
          throw new Error(
            `Browser ${browserId} cannot spawn without an immutable BrowserLaunchSpec`
          );
        }
        userDataDir = path.join(getUserDataRoot(), kernelProfileId, 'chrome-data');
        const runtimeConfig = {
          language: launchSpec.identity.language,
          timezone: launchSpec.identity.timezone,
          userAgent: launchSpec.identity.userAgent,
          geolocation: launchSpec.identity.geolocation,
          proxy: launchSpec.proxy,
          fingerprint: launchSpec.fingerprint,
        };
        const webrtcMode =
          runtimeConfig.fingerprint?.webrtc ?? (runtimeConfig.proxy?.server ? 'proxy' : 'real');
        await ensureWebrtcPreferences(userDataDir, webrtcMode);

        const extraArgs = ['--disable-blink-features=AutomationControlled'];
        // 窗口尺寸必须属于本次不可变启动快照；未指定时最大化。
        // 为投屏面板服务的浏览器必须**启动时**定尺寸——事后 resize 会让页面重排一次
        // 面板会看到这次重排，运行中的任务也可能受影响。
        const launchWindowSize = launchSpec.windowSize;
        if (launchWindowSize && launchWindowSize.width > 0 && launchWindowSize.height > 0) {
          extraArgs.push(
            `--window-size=${Math.round(launchWindowSize.width)},${Math.round(launchWindowSize.height)}`,
            '--window-position=0,0'
          );
        } else {
          extraArgs.push('--start-maximized');
        }
        if (process.platform === 'linux') extraArgs.push('--ozone-platform=x11');
        if (shouldBackgroundMode) {
          extraArgs.push(
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-timer-throttling'
          );
        }
        if (webrtcMode === 'proxy') {
          extraArgs.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
        }
        if (runtimeConfig.proxy?.bypassList?.length) {
          extraArgs.push(`--proxy-bypass-list=${runtimeConfig.proxy.bypassList.join(',')}`);
        }
        const fpConfig = toFpUserConfig(runtimeConfig, userDataDir);
        fpConfig.extraArgs = [...(fpConfig.extraArgs ?? []), ...extraArgs];

        if (fingerprintBrowser.has(kernelProfileId)) {
          await fingerprintBrowser.stop(kernelProfileId);
        }
        const handle = await fingerprintBrowser.launch(kernelProfileId, fpConfig);
        kernelStarted = true;
        activeKernelProfileId = kernelProfileId;

        browser = await puppeteer.connect({
          browserWSEndpoint: handle.browserWSEndpoint,
          defaultViewport: null,
          protocolTimeout: 0,
        });
        wsEndpoint = handle.browserWSEndpoint;
        logger(
          'Kernel browser launched for %s (profile=%s, seed=%d, platform=%s)',
          browserId,
          kernelProfileId,
          handle.seed,
          handle.config.platform
        );
      }

      if (!wsEndpoint) wsEndpoint = browser.wsEndpoint();
      const browserPid = activeKernelProfileId
        ? fingerprintBrowser.getPid(activeKernelProfileId)
        : (browser.process()?.pid ?? (await this.readPersistedBrowserConfig(browserId))?.pid);

      automation = await BrowserAutomationSession.create(browser);
      browser.on('disconnected', () => {
        automation?.dispose();
        logger('Browser %s disconnected', browserId);
      });

      const instance: BrowserInstance = {
        automation,
        browser,
        mutex: new Mutex(),
        kernelProfileId: activeKernelProfileId,
        launchGeneration: launchSpec?.generation ?? connectionOptions?.launchGeneration,
      };

      await WindowController.initialize(browserId, {
        startHidden: shouldBackgroundMode,
        callerWindow: options?.callerWindow,
      });

      if (!browser.connected) {
        throw new Error(`Browser ${browserId} disconnected during initialization`);
      }
      await this.savePersisted(browserId, {
        wsEndpoint,
        pid: browserPid,
        userDataId: effectiveUserDataId,
        userDataDir,
        backgroundMode: shouldBackgroundMode,
        launchGeneration: launchSpec?.generation ?? connectionOptions?.launchGeneration,
      });

      if (!browser.connected) {
        throw new Error(`Browser ${browserId} disconnected during initialization`);
      }

      logger('Browser %s created successfully', browserId);
      return instance;
    } catch (error) {
      automation?.dispose();
      if (browser) {
        try {
          await browser.disconnect();
        } catch {
          // ignore
        }
      }
      if (kernelStarted) {
        try {
          await fingerprintBrowser.stop(kernelProfileId);
        } catch (cleanupError) {
          logger('Failed to clean kernel launch for %s: %O', browserId, cleanupError);
        }
      }
      throw error;
    } finally {
      guard.dispose();
    }
  }

  /** Selected-page accessor for non-exclusive consumers such as screencast polling. */
  static async getSelectedPage(browserId: string): Promise<Page> {
    const instance = await this.getConnectedInstance(browserId);
    return instance.automation.getSelectedPage();
  }

  /**
   * Recovers before acquiring the active generation's lock and dispatches the operation once.
   * A transport error after dispatch is returned to the caller; the operation is never replayed.
   */
  static async runExclusive<T>(
    browserId: string,
    operation: (session: ConnectedBrowserSession) => Promise<T> | T,
    signal?: AbortSignal
  ): Promise<T> {
    for (;;) {
      signal?.throwIfAborted();
      const instance = await this.getConnectedInstance(browserId);
      const guard = await instance.mutex.acquire(signal);
      try {
        const current = this.instances.get(browserId)?.getReady();
        if (current !== instance || !instance.browser.connected) {
          continue;
        }

        signal?.throwIfAborted();
        return await this.runOperation(instance, operation, signal);
      } finally {
        guard.dispose();
      }
    }
  }

  private static async runOperation<T>(
    instance: BrowserInstance,
    operation: (session: ConnectedBrowserSession) => Promise<T> | T,
    signal?: AbortSignal
  ): Promise<T> {
    if (!signal) {
      return await operation({ automation: instance.automation, browser: instance.browser });
    }
    signal.throwIfAborted();

    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        // CdpBrowser.disconnect() disposes the local transport synchronously. Chrome keeps running,
        // while pending protocol calls reject and the next operation can reconnect by endpoint.
        try {
          void instance.browser.disconnect().catch((error) => {
            logger('Failed to disconnect cancelled browser transport: %O', error);
          });
        } catch (error) {
          logger('Failed to disconnect cancelled browser transport: %O', error);
        }
        reject(browserAbortReason(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      const running = Promise.resolve(
        operation({ automation: instance.automation, browser: instance.browser })
      );
      return await Promise.race([running, cancelled]);
    } finally {
      signal.removeEventListener('abort', onAbort!);
    }
  }

  private static async getConnectedInstance(browserId: string): Promise<BrowserInstance> {
    try {
      for (;;) {
        await this.getOrCreate(browserId);
        const instance = this.instances.get(browserId)?.getReady();
        if (instance?.browser.connected) {
          return instance;
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Browser "${browserId}" is not ready and could not be recovered: ${detail}`, {
        cause: error,
      });
  }
  }

  /** Includes creating and terminating handles so shutdown verification cannot hide them. */
  static ownedIds(): readonly string[] {
    return Object.freeze([...this.instances.keys()]);
  }

  /**
   * 检查是否持有浏览器成品（断线实例仍保留进程所有权；可用性由 ensureReady 保证）。
   */
  static has(browserId: string): boolean {
    return this.instances.get(browserId)?.getReady() !== undefined;
  }

  /**
   * 彻底关闭浏览器：经 handle.terminate——创建前/中/后语义一致、幂等；
   * 边界终止不排队不等 mutex，settle 来自 OS/库级事实。
   */
  static async close(browserId: string): Promise<void> {
    const handle = this.instances.get(browserId);
    if (!handle) {
      logger('Browser %s not found, skipping close', browserId);
      return;
    }
    await handle.terminate('close requested');
  }

  /**
   * 边界终止实现（契约①）：同步取引用直接关，簿记事后补。
   * close 失败即上抛（terminate settlement reject = 无凭据），此时持久化配置保留，
   * 交重启后 cleanupDeadBrowsers 判活处理；进程内簿记无论成败都清。
   */
  private static async destroyInstance(
    browserId: string,
    instance: BrowserInstance
  ): Promise<void> {
    logger('Closing browser: %s', browserId);
    instance.automation.dispose();

    // Puppeteer 通过 connect 接入，实际进程和常驻 CDP 通道由 FingerprintBrowser 持有。
    const isKernelSession =
      instance.kernelProfileId != null && fingerprintBrowser.has(instance.kernelProfileId);
      if (isKernelSession) {
        try {
          await instance.browser.disconnect();
        } catch {
          // ignore
        }
        await fingerprintBrowser.stop(instance.kernelProfileId!);
        logger('Kernel browser stopped for %s', browserId);
      } else {
        await this.closeWithDeadline(browserId, instance);
      }

    // 删除持久化配置
    await this.deletePersisted(browserId);
    logger('Browser %s closed and config deleted', browserId);
  }

  /**
   * 有界 close：graceful browser.close() 限期 race →
   * 超时/失败升级为 PID 级进程终止（Chrome 子进程随主进程死亡收敛）。
   * PID kill 成功/进程已不存在 = 终止凭据（允许后续删条目）；无 PID 或 kill 失败 →
   * throw（termination settlement reject → 条目保留 → 失败隔离）。
   */
  private static async closeWithDeadline(
    browserId: string,
    instance: BrowserInstance
  ): Promise<void> {
    // close 后 browser.process() 可能失效，先取 PID（connect 场景 fallback persisted）
    const pid =
      instance.browser.process()?.pid ??
      (await this.readPersistedBrowserConfig(browserId))?.pid ??
      null;

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const closePromise = instance.browser.close();
    closePromise.catch(() => {
      /* 超时放弃等待后迟到 rejection 不得成为 unhandled */
    });
    try {
      await Promise.race([
        closePromise,
        new Promise<never>((_, rejectRace) => {
          deadlineTimer = setTimeout(
            () =>
              rejectRace(
                new Error(`browser.close() did not settle within ${BROWSER_CLOSE_TIMEOUT_MS}ms`)
              ),
            BROWSER_CLOSE_TIMEOUT_MS
          );
        }),
      ]);
      return;   // graceful close 成功
    } catch (closeError) {
      logger(
        'Browser %s graceful close failed/timed out, escalating to PID kill: %o',
        browserId,
        closeError
      );
      if (pid == null) {
        throw closeError;   // 无 PID = 无升级手段，诚实失败
      }
      await this.killProcessTreeByPid(pid);
      logger('Browser %s terminated by PID kill (pid=%d)', browserId, pid);
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  }

  /**
   * PID 级进程终止：POSIX SIGKILL 主进程（Chrome 树随主进程收敛）、Windows
   * taskkill /T /F（自身有固定期限，挂起也有界）。成功或进程已不存在 = 凭据；
   * 其余失败 throw。
   */
  private static async killProcessTreeByPid(pid: number): Promise<void> {
    if (process.platform === 'win32') {
      await new Promise<void>((resolve, rejectKill) => {
        let settled = false;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          if (deadline) clearTimeout(deadline);
          fn();
        };
        try {
          const tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
          deadline = setTimeout(() => {
            try {
              tk.kill('SIGKILL');
            } catch {
              /* 已退出 */
            }
            finish(() => rejectKill(new Error(`taskkill did not settle for pid ${pid}`)));
          }, 3000);
          tk.on('exit', (code) =>
            finish(() => {
            // 128 = 进程不存在（已死同样是终止凭据）
            if (code === 0 || code === 128) resolve();
            else rejectKill(new Error(`taskkill exit ${code} for pid ${pid}`));
            })
          );
          tk.on('error', (error) => finish(() => rejectKill(error)));
        } catch (error) {
          finish(() => rejectKill(error));
        }
      });
      return;
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;   // 已死 = 凭据
      throw error;
    }
  }

  /**
   * 应用退出兜底（进程级 best-effort 终止，不苛求凭据）：
   * 快照内存句柄表中全部已知浏览器 PID 并逐个终止——优雅关闭挂死（close 永不
   * settle）时的最后防线，由 main.ts 退出超时分支调用。不上抛。
   * 只处理本进程生命周期表中的浏览器。
   */
  static async emergencyKillAll(): Promise<void> {
    const pids = new Set<number>();
    for (const handle of this.instances.values()) {
      const instance = handle.getConsumed();
      const pid = instance?.kernelProfileId
        ? fingerprintBrowser.getPid(instance.kernelProfileId)
        : instance?.browser.process()?.pid;
      if (pid) pids.add(pid);
    }
    if (pids.size === 0) return;
    logger('Emergency kill-all browsers: %o', Array.from(pids));
    await Promise.allSettled(Array.from(pids).map((pid) => this.killProcessTreeByPid(pid)));
  }

  /**
   * 关闭所有浏览器
   */
  static async closeAll(): Promise<void> {
    const browserIds = Array.from(this.instances.keys());
    logger('Closing all browsers: %o', browserIds);

    await Promise.all(browserIds.map((id) => this.close(id)));
  }

  // ========== 持久化相关 ==========

  private static async savePersisted(browserId: string, config: PersistentConfig): Promise<void> {
    try {
      const filePath = path.join(this.persistDir, `${browserId}.json`);
      await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');
      logger('Persisted config saved: %s', filePath);
    } catch (error) {
      logger('Failed to save persisted config: %O', error);
    }
  }

  private static async readPersistedBrowserConfig(
    browserId: string
  ): Promise<PersistentConfig | null> {
    try {
      const filePath = path.join(this.persistDir, `${browserId}.json`);
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private static async deletePersisted(browserId: string): Promise<void> {
    try {
      const filePath = path.join(this.persistDir, `${browserId}.json`);
      await fs.unlink(filePath);
      logger('Deleted persisted config: %s', filePath);
    } catch {
      // 忽略错误
    }
  }

  /**
   * 获取浏览器诊断信息（用于 showWindow 失败时的调试）
   */
  static async getDebugInfo(browserId: string): Promise<{
    instanceExists: boolean;
    processExists: boolean;
    processPid?: number;
    persistedConfigExists: boolean;
    persistedPid?: number;
    allBrowserIds: string[];
  }> {
    const instance = this.instances.get(browserId)?.getReady();
    const instanceExists = !!instance;

    let processExists = false;
    let processPid: number | undefined;
    if (instance) {
      const processObj = instance.browser.process();
      processExists = !!processObj?.pid;
      processPid = processObj?.pid;
    }

    const persistedConfig = await this.readPersistedBrowserConfig(browserId);
    const persistedConfigExists = !!persistedConfig?.pid;
    const persistedPid = persistedConfig?.pid;

    const allBrowserIds = Array.from(this.instances.keys());

    return {
      instanceExists,
      processExists,
      processPid,
      persistedConfigExists,
      persistedPid,
      allBrowserIds,
    };
  }

  /**
   * 清理死亡的浏览器配置
   *
   * 扫描持久化配置目录，对每个配置尝试连接测试：
   * - 连接成功：浏览器存活，保留配置
   * - 连接失败：浏览器已死亡，删除 config + state
   *
   * PilotRuntime 启动时执行一次。
   */
  static async cleanupDeadBrowsers(): Promise<void> {
    try {
      // 1. 扫描配置目录
      const files = await fs.readdir(this.persistDir);
      const configFiles = files.filter((f) => f.endsWith('.json'));

      logger('Scanning %d browser configs for cleanup', configFiles.length);

      let checkedCount = 0;
      let cleanedCount = 0;

      // 2. 并行测试所有配置
      await Promise.all(
        configFiles.map(async (file) => {
          const browserId = path.basename(file, '.json');

          // 跳过内存中已有所有权条目的浏览器（正在使用，含创建中——条目即所有权）
          if (this.instances.has(browserId)) {
            logger('Skipping active browser: %s', browserId);
            return;
          }

          checkedCount++;

          // 读取配置
          const config = await this.readPersistedBrowserConfig(browserId);
          if (!config) {
            logger('Invalid config for %s, deleting', browserId);
            await this.deletePersisted(browserId);
            cleanedCount++;
            return;
          }

          // 无端点配置不是当前运行时可写入的状态。
          if (!config.wsEndpoint) {
            logger('Config for %s has no wsEndpoint, deleting', browserId);
            await this.deletePersisted(browserId);
            cleanedCount++;
            return;
          }

          // 测试连接
          try {
            logger('Testing connection for browser: %s', browserId);
            const browser = await puppeteer.connect({
              browserWSEndpoint: config.wsEndpoint,
              defaultViewport: null,
              protocolTimeout: 5000, // 5秒超时
            });

            // 连接成功，浏览器存活
            logger('Browser %s is alive, keeping config', browserId);
            await browser.disconnect(); // 立即断开，不占用连接
          } catch (error) {
            // 连接失败，浏览器已死亡
            logger('Browser %s is dead, cleaning up: %O', browserId, error);
            await this.deletePersisted(browserId);
            cleanedCount++;
          }
        })
      );

      logger(
        'Browser cleanup completed: %d configs checked, %d cleaned',
        checkedCount,
        cleanedCount
      );
    } catch (error) {
      logger('Failed to cleanup dead browsers: %O', error);
    }
  }
}
