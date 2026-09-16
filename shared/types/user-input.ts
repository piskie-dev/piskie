export interface UserFileRef {
  readonly name: string;
  readonly path: string;
  readonly kind?: 'file' | 'directory';
}

/** Original user text and local file references, before model instructions are added. */
export interface UserMessageInput {
  readonly text: string;
  readonly files?: readonly UserFileRef[];
}
