import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ClipboardAttachmentDescriptor } from '../../../../shared/electron-contracts/desktop';
import {
  getComposerAttachments,
  useComposerAttachments,
  useComposerDraftStore,
  type ComposerAttachmentImageResource,
} from '../data/composer-drafts';
import {
  messageText,
  PresentationError,
  rawText,
} from '../../../i18n/presentationText';
import {
  isTextAttachment,
  plainTextMayReferenceImage,
  supportedImageType,
  uriListMayContainAttachment,
  type AttachmentFile,
  type AttachmentImage,
  type ImagePayload,
} from './model';
import { blobToImagePayload } from './submission';

const MAX_ATTACHMENTS = 32;

function containsSourcePath(
  resources: ReadonlyMap<string, ComposerAttachmentImageResource>,
  sourcePath: string,
): boolean {
  for (const resource of resources.values()) {
    if (resource.sourcePath === sourcePath) return true;
  }
  return false;
}

let nextAttachmentId = 0;
let nextEphemeralDraftId = 0;
const pendingDiscoveries = new Map<string, Set<symbol>>();

function attachmentId(kind: 'image' | 'file'): string {
  nextAttachmentId += 1;
  return `${kind}-${Date.now().toString(36)}-${nextAttachmentId.toString(36)}`;
}

function ephemeralDraftKey(): string {
  nextEphemeralDraftId += 1;
  return `attachment-local:${nextEphemeralDraftId.toString(36)}`;
}

function beginDiscovery(key: string): symbol {
  const token = Symbol(key);
  const pending = pendingDiscoveries.get(key) ?? new Set<symbol>();
  pending.add(token);
  pendingDiscoveries.set(key, pending);
  return token;
}

function finishDiscovery(key: string, token: symbol): boolean {
  const pending = pendingDiscoveries.get(key);
  if (!pending?.delete(token)) return false;
  if (pending.size === 0) pendingDiscoveries.delete(key);
  return true;
}

function invalidateDiscoveries(key: string): void {
  pendingDiscoveries.delete(key);
}

function fileSystemPath(file: File): string | undefined {
  const candidate = (file as File & { readonly path?: string }).path;
  return candidate?.trim() || undefined;
}

export interface AttachmentDraft {
  readonly images: readonly AttachmentImage[];
  readonly files: readonly AttachmentFile[];
  readonly hasAttachments: boolean;
  readonly handlePaste: (event: React.ClipboardEvent) => void;
  readonly remove: (id: string) => void;
  readonly clear: () => void;
  readonly imagePayloads: () => Promise<ImagePayload[] | undefined>;
}

/** 有 key 的草稿跨组件挂载驻留；无 key 的临时输入器仍在卸载时释放资源。 */
export function useAttachmentDraft(key?: string): AttachmentDraft {
  const [localKey] = useState(ephemeralDraftKey);
  const draftKey = key ?? localKey;

  const attachments = useComposerAttachments(draftKey);
  const appendImages = useComposerDraftStore((state) => state.appendImages);
  const appendFiles = useComposerDraftStore((state) => state.appendFiles);
  const removeAttachment = useComposerDraftStore((state) => state.removeAttachment);
  const clearAttachments = useComposerDraftStore((state) => state.clearAttachments);

  const clear = useCallback(() => {
    invalidateDiscoveries(draftKey);
    clearAttachments(draftKey);
  }, [clearAttachments, draftKey]);

  useEffect(() => {
    if (key !== undefined) return undefined;
    return () => {
      invalidateDiscoveries(draftKey);
      clearAttachments(draftKey);
    };
  }, [clearAttachments, draftKey, key]);

  const addBlobImages = useCallback((candidates: readonly File[]): ReadonlySet<string> => {
    const current = getComposerAttachments(draftKey);
    const fingerprints = new Set<string>();
    const additions: Array<{
      image: AttachmentImage;
      resource: ComposerAttachmentImageResource;
    }> = [];
    for (const file of candidates) {
      const mediaType = supportedImageType(file.name, file.type);
      const sourcePath = fileSystemPath(file);
      if (
        !mediaType
        || current.imageResources.size + additions.length >= MAX_ATTACHMENTS
        || (sourcePath && (
          containsSourcePath(current.imageResources, sourcePath)
          || additions.some(({ resource }) => resource.sourcePath === sourcePath)
        ))
      ) continue;
      const id = attachmentId('image');
      const previewUrl = URL.createObjectURL(file);
      const image = {
        id,
        name: file.name || 'clipboard-image',
        mediaType,
        previewUrl,
      } satisfies AttachmentImage;
      additions.push({
        image,
        resource: {
          kind: 'blob',
          blob: file,
          sourcePath,
          objectUrl: previewUrl,
        },
      });
      fingerprints.add(`${image.name}\0${file.size}`);
    }
    appendImages(draftKey, additions);
    return fingerprints;
  }, [appendImages, draftKey]);

  const addPathFiles = useCallback((candidates: readonly { name: string; path: string }[]) => {
    if (candidates.length === 0) return;
    const current = getComposerAttachments(draftKey);
    const known = new Set(current.files.map((file) => file.path));
    const additions: AttachmentFile[] = [];
    for (const file of candidates) {
      if (!file.path || known.has(file.path) || current.files.length + additions.length >= MAX_ATTACHMENTS) {
        continue;
      }
      known.add(file.path);
      additions.push({ id: attachmentId('file'), name: file.name, path: file.path });
    }
    appendFiles(draftKey, additions);
  }, [appendFiles, draftKey]);

  const importSystemDescriptors = useCallback((
    descriptors: readonly ClipboardAttachmentDescriptor[],
    directImageFingerprints: ReadonlySet<string>,
  ) => {
    const current = getComposerAttachments(draftKey);
    const imageAdditions: Array<{
      image: AttachmentImage;
      resource: ComposerAttachmentImageResource;
    }> = [];
    const fileAdditions: Array<{ name: string; path: string }> = [];
    for (const descriptor of descriptors) {
      const mediaType = supportedImageType(descriptor.name, descriptor.mediaType);
      if (mediaType && descriptor.previewUrl) {
        if (directImageFingerprints.has(`${descriptor.name}\0${descriptor.size}`)) continue;
        if (
          current.imageResources.size + imageAdditions.length >= MAX_ATTACHMENTS
          || containsSourcePath(current.imageResources, descriptor.path)
          || imageAdditions.some(({ resource }) => resource.sourcePath === descriptor.path)
        ) continue;
        const id = attachmentId('image');
        imageAdditions.push({
          image: {
            id,
            name: descriptor.name,
            mediaType,
            previewUrl: descriptor.previewUrl,
          },
          resource: {
            kind: 'url',
            url: descriptor.previewUrl,
            sourcePath: descriptor.path,
          },
        });
      } else if (isTextAttachment(descriptor.name)) {
        fileAdditions.push({ name: descriptor.name, path: descriptor.path });
      }
    }

    appendImages(draftKey, imageAdditions);
    addPathFiles(fileAdditions);
  }, [addPathFiles, appendImages, draftKey]);

  const handlePaste = useCallback((event: React.ClipboardEvent) => {
    const transfer = event.clipboardData;
    if (!transfer) return;

    const imageFiles: File[] = [];
    const textFiles: Array<{ name: string; path: string }> = [];
    let needsSystemDescriptors = false;
    for (const item of Array.from(transfer.items).slice(0, MAX_ATTACHMENTS)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      if (supportedImageType(file.name, file.type)) {
        imageFiles.push(file);
        continue;
      }
      if (!isTextAttachment(file.name, file.type)) continue;
      const path = fileSystemPath(file);
      if (path) textFiles.push({ name: file.name, path });
      else needsSystemDescriptors = true;
    }

    const uriList = transfer.getData('text/uri-list');
    if (uriListMayContainAttachment(uriList)) needsSystemDescriptors = true;
    if (plainTextMayReferenceImage(transfer.getData('text/plain'))) needsSystemDescriptors = true;
    if (imageFiles.length === 0 && textFiles.length === 0 && !needsSystemDescriptors) return;

    event.preventDefault();
    const directImageFingerprints = addBlobImages(imageFiles);
    addPathFiles(textFiles);
    if (!needsSystemDescriptors) return;

    const discovery = beginDiscovery(draftKey);
    void window.piskie.desktop.system.clipboardAttachments()
      .then((descriptors) => {
        if (!finishDiscovery(draftKey, discovery)) return;
        importSystemDescriptors(descriptors, directImageFingerprints);
      })
      .catch((error: unknown) => {
        finishDiscovery(draftKey, discovery);
        console.warn('Clipboard attachment discovery failed', error);
      });
  }, [addBlobImages, addPathFiles, draftKey, importSystemDescriptors]);

  const remove = useCallback((id: string) => {
    removeAttachment(draftKey, id);
  }, [draftKey, removeAttachment]);

  const imagePayloads = useCallback(async (): Promise<ImagePayload[] | undefined> => {
    if (attachments.images.length === 0) return undefined;
    return Promise.all(attachments.images.map((image) => {
      const resource = getComposerAttachments(draftKey).imageResources.get(image.id);
      if (!resource) {
        return Promise.reject(new PresentationError(messageText(
          'sessionWorkbenchUi.attachmentFailure.staleNamed',
          { name: rawText(image.name) },
        )));
      }
      let pending = resource.encoded;
      if (!pending) {
        pending = (resource.kind === 'blob'
          ? Promise.resolve(resource.blob)
          : fetch(resource.url, { cache: 'no-store' }).then((response) => {
              if (!response.ok) {
                throw new PresentationError(messageText(
                  'sessionWorkbenchUi.attachmentFailure.readNamed',
                  { name: rawText(image.name) },
                ));
              }
              return response.blob();
            })
        ).then((blob) => blobToImagePayload(blob, image.mediaType));
        resource.encoded = pending;
      }
      return pending;
    }));
  }, [attachments.images, draftKey]);

  return useMemo(() => ({
    images: attachments.images,
    files: attachments.files,
    hasAttachments: attachments.images.length > 0 || attachments.files.length > 0,
    handlePaste,
    remove,
    clear,
    imagePayloads,
  }), [attachments.files, attachments.images, clear, handlePaste, imagePayloads, remove]);
}
