import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_DEVELOPMENT_RENDERER_URL = 'http://127.0.0.1:5174';

export function resolveRendererEntryUrl(input: {
  development: boolean;
  appPath: string;
  devServerUrl?: string;
}): string {
  if (!input.development) {
    return pathToFileURL(path.join(input.appPath, 'dist', 'index.html')).href;
  }

  const candidate = input.devServerUrl ?? DEFAULT_DEVELOPMENT_RENDERER_URL;
  const url = new URL(candidate);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Development Renderer URL must use http or https');
  }
  return url.href;
}
