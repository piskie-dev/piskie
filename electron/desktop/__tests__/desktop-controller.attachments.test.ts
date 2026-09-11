import { describe, expect, it, vi } from 'vitest';
import { createDesktopController } from '../capabilities/desktop-controller';
import { DESKTOP_OPERATIONS } from '../../../shared/electron-contracts/desktop';

describe('attachment input contract', () => {
  it('requires explicit paths or native event metadata and scopes release to the caller window', async () => {
    const application = { clipboardAttachments: vi.fn(), previewFile: vi.fn(), releasePreview: vi.fn() };
    const { operations } = createDesktopController(application as never);
    const capture = operations.find((operation) => operation.id === DESKTOP_OPERATIONS.clipboardAttachments)!;
    expect(capture.input.safeParse([]).success).toBe(false);
    expect(capture.input.safeParse([{ kind: 'paths', paths: ['/workspace/example.png'], extra: true }]).success).toBe(false);
    const request = { kind: 'paths', paths: ['/workspace/example.png'] };
    expect(capture.input.safeParse([request]).success).toBe(true);
    const signal = new AbortController().signal;
    await capture.execute({ windowId: 7, signal } as never, [request]);
    expect(application.clipboardAttachments).toHaveBeenCalledWith(7, request, signal);
    const preview = operations.find((operation) => operation.id === DESKTOP_OPERATIONS.previewFile)!;
    await preview.execute({ windowId: 7, signal } as never, ['/workspace/example.png']);
    expect(application.previewFile).toHaveBeenCalledWith(7, '/workspace/example.png', signal);
    const release = operations.find((operation) => operation.id === DESKTOP_OPERATIONS.releasePreview)!;
    await release.execute({ windowId: 7 } as never, ['piskie-attachment://preview/example']);
    expect(application.releasePreview).toHaveBeenCalledWith(7, 'piskie-attachment://preview/example');
  });
});
