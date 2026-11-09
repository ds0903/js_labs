// querySelector says "an Element or null". This says which element, or throws:
// a page without the element it was built for is a bug, not a normal case.
export function query<T extends Element>(
  root: ParentNode,
  selector: string,
  kind: new () => T,
): T {
  const element = root.querySelector(selector);
  if (!(element instanceof kind))
    throw new Error(`${selector} is missing or of a wrong kind`);
  return element;
}

// is the keyboard event aimed at a text field (chat line, lobby form)?
export function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.matches("input, textarea, select");
}
