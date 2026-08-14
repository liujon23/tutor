// The transcript reader: an archived lesson, rendered.
//
// Transcripts are plain markdown files the server already serves statically, so
// there's no API endpoint here — just a fetch and the app's own renderer.
import { h, clear } from "../dom.js";
import { api } from "../api.js";
import { renderInto } from "../markdown.js";

/**
 * Archived images are written relative to the transcripts directory
 * (`assets/lesson-018/…`), but the app is always served from `/`, so a relative
 * src would 404. Rewrite them to the static route that actually serves them.
 *
 * In a demo build the transcript lives under `demo/transcripts/`, so its assets
 * resolve there instead. Both prefixes are allow-listed in markdown.ts — without
 * that, DOMPurify strips the src and every lesson image vanishes.
 */
export function rewriteAssetPaths(markdown: string, base: string): string {
  return markdown.replace(/(!\[[^\]]*\]\()\s*(assets\/)/g, (_m, open: string, rel: string) => `${open}${base}${rel}`);
}

// Demo: a RELATIVE prefix, matching how the recording's own images are written.
// The app never changes its URL (no router), so this resolves against the
// deploy base — and it's the form the markdown allowlist matches, which an
// absolute "/tutor/demo/..." would not be.
const assetBase = (): string => (__DEMO__ ? "demo/transcripts/" : "/transcripts/");

export async function showTranscript(
  root: HTMLElement,
  lessonNumber: number,
  onBack: () => void
): Promise<void> {
  clear(root);
  root.append(h("div", { class: "loading" }, "Loading transcript…"));

  let markdown: string;
  try {
    markdown = await api.transcript(lessonNumber);
  } catch (e) {
    clear(root);
    root.append(
      h(
        "div",
        { class: "screen transcript" },
        h(
          "header",
          { class: "app-header" },
          h("button", { class: "back", onclick: () => onBack() }, "‹"),
          h("h1", {}, `Lesson ${lessonNumber}`)
        ),
        h("div", { class: "error-box" }, (e as Error).message)
      )
    );
    return;
  }
  clear(root);

  const screen = h("div", { class: "screen transcript" });
  screen.append(
    h(
      "header",
      { class: "app-header" },
      h("button", { class: "back", onclick: () => onBack() }, "‹"),
      h("h1", {}, `Lesson ${lessonNumber}`)
    )
  );

  const article = h("article", { class: "transcript-body" });
  renderInto(article, rewriteAssetPaths(markdown, assetBase()));
  screen.append(article);
  root.append(screen);
  // Long transcripts: always start at the top, never wherever the last screen was.
  screen.scrollTop = 0;
}
