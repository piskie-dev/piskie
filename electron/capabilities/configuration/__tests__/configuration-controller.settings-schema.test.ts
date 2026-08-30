import { describe, expect, it } from 'vitest';

import { CONFIGURATION_OPERATIONS } from '../../../../shared/electron-contracts/configuration.js';
import { createConfigurationController } from '../configuration-controller.js';

describe('configuration settings boundary', () => {
  const controller = createConfigurationController({} as never, (() => undefined) as never);

  it('accepts current product preferences and rejects unknown or invalid writes', () => {
    const writeSettings = controller.operations.find(
      (operation) => operation.id === CONFIGURATION_OPERATIONS.writeSettings,
    )!;

    expect(writeSettings.input.safeParse([{
      navEdgeDockEnabled: false,
      navPrismEnabled: true,
      navPrismSpot: { x: 120, y: 240 },
      backgroundImage: 'piskie-attachment://theme-background/background-1.webp',
      backgroundMaskOpacity: 0.4,
    }]).success).toBe(true);
    expect(writeSettings.input.safeParse([{ retiredNavigation: 'sidebar' }]).success).toBe(false);
    expect(writeSettings.input.safeParse([{
      backgroundImage: 'https://example.test/wallpaper.png',
    }]).success).toBe(false);
    expect(writeSettings.input.safeParse([{ backgroundMaskOpacity: 0.01 }]).success).toBe(true);
    expect(writeSettings.input.safeParse([{ backgroundMaskOpacity: 0.99 }]).success).toBe(true);
    expect(writeSettings.input.safeParse([{ backgroundMaskOpacity: 0 }]).success).toBe(false);
    expect(writeSettings.input.safeParse([{ backgroundMaskOpacity: 1 }]).success).toBe(false);
  });

  it('exposes every current setting through single-field operations', () => {
    const readSetting = controller.operations.find(
      (operation) => operation.id === CONFIGURATION_OPERATIONS.readSetting,
    )!;
    const writeSetting = controller.operations.find(
      (operation) => operation.id === CONFIGURATION_OPERATIONS.writeSetting,
    )!;

    expect(readSetting.input.safeParse(['navPrismSpot']).success).toBe(true);
    expect(writeSetting.input.safeParse(['navPrismSpot', { x: 12, y: 34 }]).success).toBe(true);
    expect(writeSetting.input.safeParse([
      'backgroundImage',
      'piskie-attachment://theme-background/background-2.png',
    ]).success).toBe(true);
    expect(writeSetting.input.safeParse(['backgroundMaskOpacity', 0.01]).success).toBe(true);
    expect(writeSetting.input.safeParse(['backgroundMaskOpacity', 0.99]).success).toBe(true);
    expect(writeSetting.input.safeParse(['backgroundMaskOpacity', 0]).success).toBe(false);
    expect(writeSetting.input.safeParse(['backgroundMaskOpacity', 1]).success).toBe(false);
    expect(readSetting.input.safeParse(['retiredSetting']).success).toBe(false);
  });
});
