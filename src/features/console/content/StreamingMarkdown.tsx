import { memo } from 'react';

import { LinkedMarkdown } from '@/components/content-links';
import type { MarkdownImageOptions } from '@/components/content-links/MarkdownImage';

const LIVE_STREAMING = Object.freeze({
  hasNextChunk: true,
  enableAnimation: false,
  tail: false,
});

export const StreamingMarkdown = memo<MarkdownImageOptions & {
  markdown: string;
  live: boolean;
}>(({ markdown, live, baseDirectory, onPreviewImage }) => (
  <LinkedMarkdown
    baseDirectory={baseDirectory}
    onPreviewImage={onPreviewImage}
    streaming={live ? LIVE_STREAMING : undefined}
  >
    {markdown}
  </LinkedMarkdown>
));

StreamingMarkdown.displayName = 'StreamingMarkdown';
