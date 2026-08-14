// Markdown + LaTeX + code-highlighting rendering for lesson bubbles.
// Math is extracted before markdown runs (marked mangles $...$ contents),
// rendered with KaTeX, and spliced back in afterwards.
import { Marked } from "marked";
import katex from "katex";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.css";

const marked = new Marked({ gfm: true, breaks: false });

// With web tools on, fetched third-party content enters model context, and
// model output goes to innerHTML (marked does NOT sanitize) — close the loop
// by sanitizing the final HTML string every time. DOMPurify's defaults keep
// standard markdown output plus KaTeX's spans/classes/style attributes and
// strip script/event handlers/javascript: URLs; forbid embeds on top of that.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  // Images only from https, our own asset proxy, or (demo mode only) the
  // bundled demo/assets/ recording images, referenced as relative paths so
  // they resolve under whatever base the app is served from.
  if (node.tagName === "IMG") {
    const src = node.getAttribute("src") ?? "";
    const allowed =
      src.startsWith("https:") ||
      src.startsWith("/api/assets") ||
      // Archived lesson images, served read-only from the transcripts dir —
      // this is what makes images show up in the transcript reader.
      src.startsWith("/transcripts/") ||
      (__DEMO__ && (src.startsWith("demo/assets/") || src.startsWith("demo/transcripts/")));
    if (!allowed) node.removeAttribute("src");
  }
});

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["iframe", "video", "audio", "embed", "object", "form", "base"],
  });
}

interface MathSegment {
  html: string;
}

/**
 * Pull ```mermaid fences out before anything else touches the source (the
 * math extractor shields generic fences, so this must run first). While
 * streaming, an unclosed trailing fence is captured too — a half-streamed
 * diagram is invalid mermaid and would flash errors under the per-frame
 * re-render, so it shows as a placeholder box until the message finalizes.
 */
function extractMermaid(src: string, includeUnclosed: boolean): { text: string; codes: string[] } {
  const codes: string[] = [];
  let text = src.replace(/```mermaid[^\n]*\n([\s\S]*?)```/g, (_, code: string) => {
    codes.push(code.trim());
    return `\uE000MERMAID${codes.length - 1}\uE001`;
  });
  if (includeUnclosed) {
    text = text.replace(/```mermaid[^\n]*(?:\n[\s\S]*)?$/, () => {
      codes.push(""); // still streaming — only the placeholder box is shown
      return `\uE000MERMAID${codes.length - 1}\uE001`;
    });
  }
  return { text, codes };
}

const PLACEHOLDER = (i: number) => `MATH${i}`;

/** Pull $$...$$, $...$, \[...\], \(...\) out; return text with placeholders. */
function extractMath(src: string): { text: string; segments: MathSegment[] } {
  const segments: MathSegment[] = [];
  const push = (tex: string, display: boolean): string => {
    let html: string;
    try {
      html = katex.renderToString(tex, { displayMode: display, throwOnError: false });
    } catch {
      html = escapeHtml(tex);
    }
    segments.push({ html });
    return PLACEHOLDER(segments.length - 1);
  };

  let text = src;
  // Fenced code blocks must be left alone — shield them first.
  const fences: string[] = [];
  text = text.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => {
    fences.push(m);
    return `FENCE${fences.length - 1}`;
  });

  text = text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => push(tex, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex: string) => push(tex, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex: string) => push(tex, false))
    // Inline $...$: no leading/trailing space inside, no $ or newline within.
    .replace(/\$([^\s$][^$\n]*?[^\s$]|\S)\$/g, (_, tex: string) => push(tex, false));

  text = text.replace(/FENCE(\d+)/g, (_, i: string) => fences[Number(i)]);
  return { text, segments };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderMarkdown(
  src: string,
  opts: { finalize?: boolean } = {}
): { html: string; mermaidCodes: string[] } {
  const finalize = opts.finalize !== false;
  const mm = extractMermaid(src, !finalize);
  const { text, segments } = extractMath(mm.text);
  let html = marked.parse(text, { async: false });
  html = html.replace(/MATH(\d+)/g, (_, i: string) => segments[Number(i)].html);
  // A slot token usually lands as its own paragraph — swallow the <p> so the
  // placeholder div doesn't get auto-split out of it by the HTML parser.
  html = html.replace(
    /<p>\uE000MERMAID(\d+)\uE001<\/p>|\uE000MERMAID(\d+)\uE001/g,
    (_, a: string | undefined, b: string | undefined) =>
      `<div class="diagram-box" data-mermaid="${a ?? b}">diagram…</div>`
  );
  return { html, mermaidCodes: mm.codes };
}

// ---------------------------------------------------------------------------
// Mermaid — dynamic-imported on first use (~1 MB+; keeps the initial bundle
// lean) and rendered only on message finalize.
// ---------------------------------------------------------------------------

let mermaidLoad: Promise<typeof import("mermaid")> | null = null;
let mermaidSeq = 0;

function loadMermaid(): Promise<typeof import("mermaid")> {
  mermaidLoad ??= import("mermaid").then((m) => {
    m.default.initialize({
      startOnLoad: false,
      theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "neutral",
      suppressErrorRendering: true,
    });
    return m;
  });
  return mermaidLoad;
}

async function renderMermaidInto(slot: HTMLElement, code: string): Promise<void> {
  const id = `mm-${++mermaidSeq}`;
  // Bad syntax — or a "successful" but empty render — degrades to a plain code
  // block, never a blank hole.
  const fallbackToCode = () => {
    document.getElementById(`d${id}`)?.remove(); // mermaid's leftover scratch node
    const pre = document.createElement("pre");
    const codeEl = document.createElement("code");
    codeEl.textContent = code;
    pre.append(codeEl);
    slot.replaceWith(pre);
  };
  try {
    const mermaid = (await loadMermaid()).default;
    const { svg } = await mermaid.render(id, code);
    const wrap = document.createElement("div");
    wrap.className = "diagram";
    // Mermaid's SVG is generated locally from the fence text, so it's inserted
    // as a DOM node AFTER the surrounding HTML was sanitized — running it
    // through DOMPurify would mangle it and complicate the sanitizer config.
    wrap.innerHTML = svg;
    const svgEl = wrap.querySelector("svg");
    const vb = svgEl
      ?.getAttribute("viewBox")
      ?.split(/[\s,]+/)
      .map(Number);
    if (!svgEl || !vb || vb.length !== 4 || !(vb[2] > 0) || !(vb[3] > 0)) {
      fallbackToCode();
      return;
    }
    // Mermaid ships the SVG as width="100%" with NO height, leaning on the
    // viewBox for aspect ratio. Chromium copes, but WebKit/mobile Safari
    // collapses that shape to height 0 — the diagram renders blank (seen on
    // the learner's client). Pin the intrinsic width/height from the viewBox and let CSS
    // (max-width:100%; height:auto) scale it down responsively — the standard
    // cross-browser inline-SVG pattern.
    svgEl.setAttribute("width", String(vb[2]));
    svgEl.setAttribute("height", String(vb[3]));
    svgEl.style.maxWidth = "100%";
    svgEl.style.height = "auto";
    slot.replaceWith(wrap);
  } catch {
    fallbackToCode();
  }
}

/**
 * Render into a container and highlight code blocks. Pass `finalize: false`
 * while streaming — mermaid fences show as placeholder boxes and only render
 * to SVG on the finalized message (a half-streamed fence is invalid mermaid).
 */
export function renderInto(el: HTMLElement, src: string, opts: { finalize?: boolean } = {}): void {
  const finalize = opts.finalize !== false;
  const { html, mermaidCodes } = renderMarkdown(src, opts);
  el.innerHTML = sanitize(html);
  el.querySelectorAll("pre code").forEach((block) => {
    hljs.highlightElement(block as HTMLElement);
  });
  // External links open outside the PWA shell.
  el.querySelectorAll("a[href]").forEach((a) => {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener");
  });
  // Remote images go through the asset proxy (validate + cache + archive);
  // a broken one degrades to a visible captioned link, never a broken icon.
  el.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    const original = img.getAttribute("src") ?? "";
    if (original.startsWith("http")) {
      img.setAttribute("src", `/api/assets?src=${encodeURIComponent(original)}`);
    }
    img.setAttribute("loading", "lazy");
    img.addEventListener(
      "error",
      () => {
        const a = document.createElement("a");
        a.href = original.startsWith("http") ? original : img.src;
        a.target = "_blank";
        a.rel = "noopener";
        a.className = "img-fallback";
        a.textContent = `image unavailable — ${img.alt || "open original"}`;
        img.replaceWith(a);
      },
      { once: true }
    );
  });
  if (finalize) {
    el.querySelectorAll<HTMLElement>("[data-mermaid]").forEach((slot) => {
      const code = mermaidCodes[Number(slot.dataset.mermaid)];
      if (code) void renderMermaidInto(slot, code);
    });
  }
}
