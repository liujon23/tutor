// ---------------------------------------------------------------------------
// Tiny DOM helper — shared by the select screen and the lesson screen.
// ---------------------------------------------------------------------------

export type Child = Node | string | null | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | ((ev: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}
