import { createContext } from 'react';
import type { ImagePreviewHandler } from '../image-preview/renderedImageContext';

export interface MarkdownImageOptions {
  readonly baseDirectory?: string;
  readonly onPreviewImage?: ImagePreviewHandler;
}

export const MarkdownImageContext = createContext<MarkdownImageOptions>({});
