import { existsSync } from 'node:fs';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  createFromBuffer: vi.fn(), createFromDataURL: vi.fn(),
  loadURL: vi.fn(), executeJavaScript: vi.fn(), destroy: vi.fn(),
  writeImage: vi.fn(), readImage: vi.fn(),
}));
vi.mock('electron', () => ({
  nativeImage: { createFromBuffer: native.createFromBuffer, createFromDataURL: native.createFromDataURL },
  clipboard: { writeImage: native.writeImage, readImage: native.readImage },
  BrowserWindow: class {
    loadURL = native.loadURL;
    webContents = { executeJavaScript: native.executeJavaScript };
    isDestroyed = () => false;
    destroy = native.destroy;
  },
}));
import { copyImageContents } from '../capabilities/image-file-clipboard.js';

const chromiumPath = process.env.FP_CHROMIUM_PATH;
const canRun = Boolean(chromiumPath && existsSync(chromiumPath));

function withExifOrientation(jpeg: Buffer, orientation: number): Uint8Array {
  const app1 = Buffer.alloc(36);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(34, 2);
  app1.write('Exif\0\0', 4, 'ascii');
  app1.write('II', 10, 'ascii');
  app1.writeUInt16LE(42, 12);
  app1.writeUInt32LE(8, 14);
  app1.writeUInt16LE(1, 18);
  app1.writeUInt16LE(0x0112, 20); // TIFF Orientation, one SHORT value.
  app1.writeUInt16LE(3, 22);
  app1.writeUInt32LE(1, 24);
  app1.writeUInt16LE(orientation, 28);
  return new Uint8Array(Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]));
}

// Executes the production decoder script in real Chromium; Electron and the OS clipboard are test doubles.
describe.skipIf(!canRun)('JPEG clipboard pixel orientation in Chromium', () => {
  let browser: Browser;
  let page: Page;
  let jpeg: Buffer;

  beforeAll(async () => {
    browser = await puppeteer.launch({
      executablePath: chromiumPath!, headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    page = await browser.newPage();
    const dataUrl = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 32;
      const context = canvas.getContext('2d')!;
      for (const [index, color] of ['#ff0000', '#00ff00', '#0000ff', '#ffff00'].entries()) {
        context.fillStyle = color;
        context.fillRect((index % 2) * 32, Math.floor(index / 2) * 16, 32, 16);
      }
      return canvas.toDataURL('image/jpeg', 1);
    });
    jpeg = Buffer.from(dataUrl.split(',')[1]!, 'base64');
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
    native.loadURL.mockImplementation(async (url: string) => { await page.goto(url); });
    native.executeJavaScript.mockImplementation((script: string) => page.evaluate(script));
    native.createFromDataURL.mockImplementation((dataUrl: string) => {
      const png = Buffer.from(dataUrl.split(',')[1]!, 'base64');
      return {
        dataUrl, isEmpty: () => false,
        getSize: () => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }),
      };
    });
    native.readImage.mockImplementation(() => native.writeImage.mock.lastCall![0]);
  });

  afterAll(async () => { await browser?.close(); });

  async function snapshot(dataUrl: string) {
    return page.evaluate(async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const corners = [[1, 1], [3, 1], [1, 3], [3, 3]].map(([x, y]) => {
        const pixel = context.getImageData(width * x! / 4, height * y! / 4, 1, 1).data;
        return Array.from(pixel.subarray(0, 3)).map((channel) => channel > 127 ? 'ff' : '00').join('');
      });
      return { width, height, corners };
    }, dataUrl);
  }

  it.each([
    [1, ['ff0000', '00ff00', '0000ff', 'ffff00']],
    [2, ['00ff00', 'ff0000', 'ffff00', '0000ff']],
    [3, ['ffff00', '0000ff', '00ff00', 'ff0000']],
    [4, ['0000ff', 'ffff00', 'ff0000', '00ff00']],
    [5, ['ff0000', '0000ff', '00ff00', 'ffff00']],
    [6, ['0000ff', 'ff0000', 'ffff00', '00ff00']],
    [7, ['ffff00', '00ff00', '0000ff', 'ff0000']],
    [8, ['00ff00', 'ffff00', 'ff0000', '0000ff']],
  ] as const)('copies the browser-visible dimensions and corner pixels for EXIF Orientation=%i', async (orientation, corners) => {
    const bytes = withExifOrientation(jpeg, orientation);
    const preview = await snapshot(`data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`);
    expect(preview).toEqual({
      width: orientation >= 5 ? 32 : 64, height: orientation >= 5 ? 64 : 32, corners,
    });
    await expect(copyImageContents({ kind: 'bytes', bytes: new Uint8Array(bytes).buffer }, vi.fn())).resolves.toBeUndefined();
    expect(native.writeImage).toHaveBeenCalledOnce();
    expect(native.createFromDataURL).toHaveBeenCalledOnce();
    const copied = native.writeImage.mock.lastCall![0];
    expect(copied.getSize()).toEqual({ width: preview.width, height: preview.height });
    expect(await snapshot(copied.dataUrl)).toEqual(preview);
    expect(native.destroy).toHaveBeenCalledOnce();
  });
});
