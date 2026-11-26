/** Native inputs retain their platform clipboard handling. */
export function pasteLinkedClipboardText(
  _input: HTMLElement,
  _clipboard: Pick<DataTransfer, "getData"> | null,
): boolean {
  return false;
}

export function pasteWeWorkClipboardText(
  _input: HTMLElement,
  _clipboard: Pick<DataTransfer, "getData"> | null,
): boolean {
  return false;
}

export function pasteInternalLinkHintedText(
  _input: HTMLElement,
  _clipboard: Pick<DataTransfer, "getData"> | null,
): boolean {
  return false;
}
