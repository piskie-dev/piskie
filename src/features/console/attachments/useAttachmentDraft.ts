import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { messageText, presentationFromError, type PresentationText } from '../../../i18n/presentationText';
import type { ClipboardAttachmentRequest } from '../../../../shared/electron-contracts/desktop';
import {
  attachmentId, captureComposerImages, getComposerAttachments, useComposerAttachments,
  useComposerDraftStore, withAttachmentSubmission,
} from '../data/composer-drafts';
import {
  attachmentPathsFromUriList, isTextAttachment, plainTextMayReferenceImage, supportedImageType,
  type AttachmentFile, type AttachmentImage, type ImagePayload,
} from './model';

function fileSystemPath(file: File): string | undefined {
  return (file as File & { readonly path?: string }).path || undefined;
}

export interface AttachmentDraft {
  readonly images: readonly AttachmentImage[];
  readonly files: readonly AttachmentFile[];
  readonly hasAttachments: boolean;
  readonly handlePaste: (event: React.ClipboardEvent, insertText?: (value: string) => void) => void;
  readonly remove: (id: string) => void;
  readonly clear: () => void;
  readonly error?: PresentationText;
  readonly submitting: boolean;
  readonly withImages: (submit: (images: ImagePayload[] | undefined, files: readonly AttachmentFile[]) => Promise<unknown>) => Promise<boolean>;
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

  const handlePaste = useCallback((event: React.ClipboardEvent, insertText = onTextChange) => {
    const transfer = event.clipboardData;
    if (!transfer) return;
    // Extract all event data before any asynchronous work or input update.
    const files = Array.from(transfer.items).flatMap((item) => {
      const file = item.kind === 'file' ? item.getAsFile() : null;
      return file ? [file] : [];
    });
    const plain = transfer.getData('text/plain');
    const plainIsSource = plainTextMayReferenceImage(plain);
    const paths = [...new Set([...attachmentPathsFromUriList(transfer.getData('text/uri-list')), ...(plainIsSource ? [plain.trim()] : [])])];
    const imageFiles = files.filter((file) => supportedImageType(file.name, file.type));
    const textFiles = files.filter((file) => !supportedImageType(file.name, file.type) && isTextAttachment(file.name, file.type));
    const unresolved = textFiles.filter((file) => !fileSystemPath(file));
    const native = paths.length === 0 && (unresolved.length > 0
      || (imageFiles.length === 0 && Array.from(transfer.types ?? []).some((type) => ['public.file-url', 'NSFilenamesPboardType', 'FileNameW'].includes(type))));
    const sourcePaths = paths.filter((source) => {
      const name = source.startsWith('file:') ? decodeURIComponent(new URL(source).pathname.split('/').at(-1) ?? '')
        : source.replaceAll('\\', '/').split('/').at(-1) ?? '';
      return !(supportedImageType(name) && imageFiles.some((file) => file.name === name || fileSystemPath(file) === source));
    });
    if (imageFiles.length === 0 && textFiles.length === 0 && paths.length === 0 && !native) return;
    event.preventDefault();
    if (plain && !plainIsSource && insertText) {
      const input = event.currentTarget as HTMLInputElement | HTMLTextAreaElement;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      const value = input.value.slice(0, start) + plain + input.value.slice(end);
      insertText(value);
      // Restore the caret after React has committed the controlled text.
      queueMicrotask(() => { if (input.isConnected) input.setSelectionRange(start + plain.length, start + plain.length); });
    }
    const knownPaths = new Set(getComposerAttachments(draftKey).files.map((file) => file.path));
    const additions = textFiles.flatMap((file) => {
      const path = fileSystemPath(file);
      if (!path || knownPaths.has(path)) return [];
      knownPaths.add(path);
      return [{ id: attachmentId(), name: file.name, path }];
    });
    useComposerDraftStore.getState().appendFiles(draftKey, additions);
    const request: ClipboardAttachmentRequest | undefined = sourcePaths.length > 0 ? { kind: 'paths', paths: sourcePaths }
      : native ? { kind: 'native', files: files.map((file) => ({ name: file.name, size: file.size })), text: plain } : undefined;
    if (imageFiles.length > 0 || request) captureComposerImages(draftKey, imageFiles,
      request ? () => window.piskie.desktop.system.clipboardAttachments(request) : undefined);
  }, [draftKey, onTextChange]);

  const withImages = useCallback(async (submit: (images: ImagePayload[] | undefined, files: readonly AttachmentFile[]) => Promise<unknown>) => {
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
    handlePaste, remove, clear, withImages,
  }), [attachments, clear, error, handlePaste, remove, submitting, withImages]);
}
