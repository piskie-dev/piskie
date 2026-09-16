import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { messageText, presentationFromError, type PresentationText } from '../../../i18n/presentationText';
import type { ClipboardAttachmentDescriptor, ClipboardAttachmentRequest } from '../../../../shared/electron-contracts/desktop';
import type { UserFileRef } from '../../../../shared/types/user-input';
import {
  attachmentId, captureComposerImages, useComposerAttachments, useComposerDraftStore,
  withAttachmentSubmission,
} from '../data/composer-drafts';
import {
  attachmentPathKey, attachmentPathsFromUriList, plainTextMayReferenceImage, supportedImageType,
  type AttachmentFile, type AttachmentImage, type ImagePayload,
} from './model';

const NATIVE_FILE_TYPES = new Set(['public.file-url', 'NSFilenamesPboardType', 'FileNameW']);

function transferFiles(transfer: DataTransfer): File[] {
  const files = transfer.files ? Array.from(transfer.files) : [];
  // files and items expose the same files, potentially through different File objects.
  if (files.length > 0) return files;
  for (const item of Array.from(transfer.items ?? [])) {
    const file = item.kind === 'file' ? item.getAsFile() : null;
    if (file) files.push(file);
  }
  return files;
}

async function discoverAttachments(
  request: ClipboardAttachmentRequest,
  directoryPaths: readonly string[],
): Promise<ClipboardAttachmentDescriptor[]> {
  const { system, files } = window.piskie.desktop;
  // Keep the complete request so the desktop still validates the whole batch and its limit.
  const descriptors = await system.clipboardAttachments(request);
  if (directoryPaths.length === 0) return descriptors;
  const directoryKeys = new Set(directoryPaths.map((path) => attachmentPathKey(path, system.platform)));
  if (request.kind === 'paths' && request.paths.every((path) => directoryKeys.has(attachmentPathKey(path, system.platform)))) {
    return descriptors.map((item) => item.kind === 'file' ? { ...item, kind: 'directory' } : item);
  }
  try {
    // Resolve the known directory group separately; realpath and deduplication may change its paths and count.
    const directories = await system.clipboardAttachments({ kind: 'paths', paths: directoryPaths });
    const releases = await Promise.allSettled(directories.map((item) => item.kind === 'image'
      ? files.releasePreview(item.previewUrl) : undefined));
    const failed = releases.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const paths = new Set(directories.filter((item) => item.kind === 'file').map((item) => item.path));
    return descriptors.map((item) => item.kind === 'file' && paths.has(item.path)
      ? { ...item, kind: 'directory' } : item);
  } catch (error) {
    await Promise.allSettled(descriptors.map((item) => item.kind === 'image'
      ? files.releasePreview(item.previewUrl) : undefined));
    throw error;
  }
}

function sourceName(source: string): string {
  if (source.startsWith('file:')) {
    return decodeURIComponent(new URL(source).pathname.split('/').at(-1) ?? '');
  }
  return source.replaceAll('\\', '/').split('/').at(-1) ?? '';
}

export interface AttachmentDraft {
  readonly images: readonly AttachmentImage[];
  readonly files: readonly AttachmentFile[];
  readonly hasAttachments: boolean;
  readonly handlePaste: (event: React.ClipboardEvent, insertText?: (value: string) => void) => void;
  readonly handleDragOver: (event: React.DragEvent) => void;
  readonly handleDrop: (event: React.DragEvent, insertText?: (value: string) => void) => void;
  readonly remove: (id: string) => void;
  readonly clear: () => void;
  readonly error?: PresentationText;
  readonly submitting: boolean;
  readonly withImages: (submit: (images: ImagePayload[] | undefined, files: readonly UserFileRef[]) => Promise<unknown>) => Promise<boolean>;
}

/** Keyed drafts survive layout changes; local feedback drafts end with their input. */
export function useAttachmentDraft(key?: string, onTextChange?: (value: string) => void): AttachmentDraft {
  const [localKey] = useState(() => `attachment-local:${attachmentId()}`);
  const draftKey = key ?? localKey;
  const attachments = useComposerAttachments(draftKey);
  const [error, setError] = useState<PresentationText>();
  const [submitting, setSubmitting] = useState(false);
  const busy = useRef(false);
  const clear = useCallback(() => useComposerDraftStore.getState().clearAttachments(draftKey), [draftKey]);
  const remove = useCallback((id: string) => useComposerDraftStore.getState().removeAttachment(draftKey, id), [draftKey]);
  useEffect(() => {
    if (key !== undefined) return;
    return () => useComposerDraftStore.getState().resetDraft(draftKey);
  }, [draftKey, key]);

  const handleTransfer = useCallback((
    event: React.ClipboardEvent | React.DragEvent,
    transfer: DataTransfer,
    insertText = onTextChange,
  ) => {
    if (!transfer) return;
    // Extract all event data before any asynchronous work or input update.
    const files = transferFiles(transfer);
    const plain = transfer.getData('text/plain');
    const plainIsSource = plainTextMayReferenceImage(plain);
    const filePaths = new Map(files.map((file) => [file, window.piskie.desktop.files.getPathForFile(file)]));
    const pathKey = (path: string) => attachmentPathKey(path, window.piskie.desktop.system.platform);
    const directoryFiles = new Set<File>();
    const directorySources = new Map<string, string>();
    for (const item of Array.from(transfer.items ?? [])) {
      if (item.kind !== 'file' || !item.webkitGetAsEntry?.()?.isDirectory) continue;
      const file = item.getAsFile();
      if (!file) continue;
      directoryFiles.add(file);
      const path = filePaths.get(file) ?? window.piskie.desktop.files.getPathForFile(file);
      if (path) directorySources.set(pathKey(path), path);
    }
    const imageFiles = files.filter((file) => !directoryFiles.has(file)
      && !directorySources.has(pathKey(filePaths.get(file) ?? '')) && supportedImageType(file.name, file.type));
    const unresolvedFiles = files.filter((file) => !imageFiles.includes(file) && !filePaths.get(file));
    const native = unresolvedFiles.length > 0 || (files.length === 0
      && Array.from(transfer.types ?? []).some((type) => NATIVE_FILE_TYPES.has(type)));
    const candidates = [
      ...files.flatMap((file) => filePaths.get(file) || []),
      ...attachmentPathsFromUriList(transfer.getData('text/uri-list')),
      ...(plainIsSource ? [plain.trim()] : []),
    ];
    const paths = new Map<string, string>();
    for (const source of candidates) {
      const key = attachmentPathKey(source, window.piskie.desktop.system.platform);
      if (!paths.has(key)) paths.set(key, source);
    }
    const imagePathKeys = new Set(imageFiles.flatMap((file) => {
      const path = filePaths.get(file);
      return path ? [attachmentPathKey(path, window.piskie.desktop.system.platform)] : [];
    }));
    const sourcePaths = [...paths.entries()].flatMap(([key, source]) => {
      const name = sourceName(source);
      return !directorySources.has(key) && (imagePathKeys.has(key) || (supportedImageType(name) && imageFiles.some((file) => file.name === name)))
        ? [] : [source];
    });
    const request: ClipboardAttachmentRequest | undefined = native
      ? { kind: 'native', files: files.map((file) => ({ name: file.name, size: file.size })), text: plain }
      : sourcePaths.length > 0 ? { kind: 'paths', paths: sourcePaths } : undefined;
    if (imageFiles.length === 0 && !request) return;
    event.preventDefault();
    if ('dataTransfer' in event) event.stopPropagation();
    if (plain && !plainIsSource && insertText) {
      const input = event.currentTarget as HTMLInputElement | HTMLTextAreaElement;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      const value = input.value.slice(0, start) + plain + input.value.slice(end);
      insertText(value);
      // Restore the caret after React has committed the controlled text.
      queueMicrotask(() => { if (input.isConnected) input.setSelectionRange(start + plain.length, start + plain.length); });
    }
    captureComposerImages(draftKey, imageFiles,
      request ? () => discoverAttachments(request, [...directorySources.values()]) : undefined);
  }, [draftKey, onTextChange]);

  const handlePaste = useCallback((event: React.ClipboardEvent, insertText = onTextChange) => {
    handleTransfer(event, event.clipboardData, insertText);
  }, [handleTransfer, onTextChange]);
  const handleDragOver = useCallback((event: React.DragEvent) => {
    const transfer = event.dataTransfer;
    if (!Array.from(transfer.types ?? []).includes('Files') && transfer.files.length === 0) return;
    event.preventDefault();
    transfer.dropEffect = 'copy';
  }, []);
  const handleDrop = useCallback((event: React.DragEvent, insertText = onTextChange) => {
    handleTransfer(event, event.dataTransfer, insertText);
  }, [handleTransfer, onTextChange]);

  const withImages = useCallback(async (submit: (images: ImagePayload[] | undefined, files: readonly UserFileRef[]) => Promise<unknown>) => {
    if (busy.current) return false;
    busy.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await withAttachmentSubmission(draftKey, submit);
      if (result === false) setError(messageText('sessionWorkbenchUi.attachmentFailure.delivery'));
      return result !== false;
    } catch (failure) {
      setError(presentationFromError(failure, messageText('sessionWorkbenchUi.attachmentFailure.delivery')));
      return false;
    } finally { busy.current = false; setSubmitting(false); }
  }, [draftKey]);

  return useMemo(() => ({
    images: attachments.images, files: attachments.files, error, submitting,
    hasAttachments: attachments.images.length > 0 || attachments.files.length > 0,
    handlePaste, handleDragOver, handleDrop, remove, clear, withImages,
  }), [attachments, clear, error, handleDragOver, handleDrop, handlePaste, remove, submitting, withImages]);
}
