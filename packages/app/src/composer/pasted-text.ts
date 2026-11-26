import type { WeWorkMessageComposerAttachment } from "@/attachments/types";

export interface WeWorkPasteCallbacks {
  onAddAttachment: (attachment: WeWorkMessageComposerAttachment) => void;
  onUpdateAttachment: (
    id: string,
    update: { title: string; subtitle: string; text: string },
  ) => void;
  isDisposed?: () => boolean;
}

/** Native inputs retain their platform clipboard handling. */
export function pasteLinkedClipboardText(
  _input: HTMLElement,
  _clipboard: Pick<DataTransfer, "getData"> | null,
): boolean {
  return false;
}

export function handleWeWorkClipboardPaste(
  _clipboard: Pick<DataTransfer, "getData"> | null,
  _callbacks: WeWorkPasteCallbacks,
): boolean {
  return false;
}

export function pasteInternalLinkHintedText(
  _input: HTMLElement,
  _clipboard: Pick<DataTransfer, "getData"> | null,
): boolean {
  return false;
}
