/** Canonical on-disk reference to an image owned by an Agent conversation. */
export interface ImageRefBlock {
  readonly type: 'image_ref';
  readonly path: string;
  readonly size: number;
  readonly mediaType: string;
}
