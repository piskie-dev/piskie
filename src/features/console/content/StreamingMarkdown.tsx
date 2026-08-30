import { memo } from 'react';

import { LinkedMarkdown } from '@/components/content-links';

const LIVE_STREAMING = Object.freeze({
  hasNextChunk: true,
  enableAnimation: false,
  tail: false,
});

export const StreamingMarkdown = memo<{
  markdown: string;
  live: boolean;
}>(({ markdown, live }) => (
  <LinkedMarkdown
    streaming={live ? LIVE_STREAMING : undefined}
  >
    {markdown}
  </LinkedMarkdown>
));

StreamingMarkdown.displayName = 'StreamingMarkdown';
