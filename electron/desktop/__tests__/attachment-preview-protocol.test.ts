import { beforeEach, describe, expect, it, vi } from 'vitest';

const registerSchemesAsPrivileged = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged },
}));

import {
  ATTACHMENT_PREVIEW_SCHEME,
  registerAttachmentPreviewScheme,
} from '../attachment-preview-protocol.js';

describe('attachment preview scheme', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers a secure fetchable streaming scheme', () => {
    registerAttachmentPreviewScheme();

    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([{
      scheme: ATTACHMENT_PREVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    }]);
  });
});
