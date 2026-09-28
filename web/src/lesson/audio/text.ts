// ---------------------------------------------------------------------------
// Markdown + LaTeX → speakable text, and the streaming chunker that decides
// when a slice of a still-arriving tutor message is safe to hand to speech.
//
// IMPORTANT: this module imports nothing. It is compiled by BOTH the web build
// and the root tsconfig (so tests/ can reach it without a browser), and those
// two programs disagree about module resolution and ambient globals — a single
// import of anything under web/src/ would break one of them. Keep it pure.
// (Same rule as web/src/lesson/reconcile.ts.)
//
// Two hard rules, both from docs/drive-mode-plan.md:
// - Nothing the voice receives may contain a markdown sigil. Anything that had
//   to be stripped crudely is reported in `notes`, so the diag log shows what
//   this module could not handle rather than it being silently mangled.
// - Currency is not math. "$50 to $100" must come out as dollars, not vanish
//   into a formula (web/src/markdown.ts's extractMath would eat it).
// ---------------------------------------------------------------------------

/** Converted text plus what the conversion had to do to get there. */
export interface Speech {
  text: string;
  /** e.g. "placeholder:table", "tex:unknown \\foo", "stripped:*". */
  notes: string[];
}

// Spoken in place of content that only makes sense on screen. Normalising a
// table (or reading out an equation) is worse than saying it's there.
export const PLACEHOLDER = {
  table: "There's a table here, it's in the app.",
  code: "There's a code block here, it's in the app.",
  diagram: "There's a diagram here, it's in the app.",
  equation: "There's an equation here, it's in the app.",
  image: "There's an image here, it's in the app.",
} as const;

/** Introduces a run of nested list items, which are flattened into the parent. */
export const NESTED_INTRO = "Under that:";

/** Characters that must never reach the voice. `http` is checked separately. */
const SIGIL_CHARS = ["$", "*", "#", "|", "\\", "_", "^", "`"];

/** Every markdown sigil (or URL) present in text meant for the voice. */
export function findSigils(text: string): string[] {
  const found = SIGIL_CHARS.filter((c) => text.includes(c));
  if (/https?:/i.test(text)) found.push("http");
  return found;
}

// ---------------------------------------------------------------------------
// Inline spans: code, math, currency. One heuristic, shared by the converter
// and the chunker's sentence splitter, so they can never disagree.
// ---------------------------------------------------------------------------

export type SpanKind = "code" | "math" | "display" | "currency" | "dollar";

export interface Span {
  kind: SpanKind;
  start: number;
  end: number; // exclusive
  /** Inner text: code/math body, or the currency amount (digits + scale). */
  body: string;
}

const CURRENCY_RE = /^(\d[\d,]*(?:\.\d+)?)(\s?(?:k|K|M|B|bn|thousand|million|billion|trillion)\b)?/;

/**
 * Find inline code, math and currency spans in one line of markdown.
 *
 * A `$…$` pair is math unless it looks like prose between two prices: the body
 * may not start or end with whitespace, and a body starting with a digit whose
 * closing `$` is immediately followed by another digit ("$5-$10") is currency.
 * A `$` that opens no math and precedes a number is currency; any other `$` is
 * a stray sign.
 */
export function inlineSpans(s: string): Span[] {
  const spans: Span[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "`") {
      let run = 1;
      while (s[i + run] === "`") run++;
      const fence = "`".repeat(run);
      const close = s.indexOf(fence, i + run);
      if (close !== -1) {
        spans.push({ kind: "code", start: i, end: close + run, body: s.slice(i + run, close) });
        i = close + run;
        continue;
      }
      i += run;
      continue;
    }
    if (c === "\\" && (s[i + 1] === "(" || s[i + 1] === "[")) {
      const closer = s[i + 1] === "(" ? "\\)" : "\\]";
      const close = s.indexOf(closer, i + 2);
      if (close !== -1) {
        spans.push({
          kind: s[i + 1] === "(" ? "math" : "display",
          start: i,
          end: close + 2,
          body: s.slice(i + 2, close),
        });
        i = close + 2;
        continue;
      }
      i += 2;
      continue;
    }
    if (c === "\\" && s[i + 1] === "$") {
      // An escaped dollar is always a literal sign — currency if a number follows.
      const m = s.slice(i + 2).match(CURRENCY_RE);
      if (m) {
        spans.push({ kind: "currency", start: i, end: i + 2 + m[0].length, body: m[0] });
        i += 2 + m[0].length;
      } else {
        spans.push({ kind: "dollar", start: i, end: i + 2, body: "" });
        i += 2;
      }
      continue;
    }
    if (c === "$") {
      if (s[i + 1] === "$") {
        const close = s.indexOf("$$", i + 2);
        if (close !== -1) {
          spans.push({ kind: "display", start: i, end: close + 2, body: s.slice(i + 2, close) });
          i = close + 2;
          continue;
        }
        spans.push({ kind: "dollar", start: i, end: i + 2, body: "" });
        i += 2;
        continue;
      }
      const close = nextSingleDollar(s, i + 1);
      if (close !== -1) {
        const body = s.slice(i + 1, close);
        const isMath =
          body.length > 0 &&
          !/^\s/.test(body) &&
          !/\s$/.test(body) &&
          !(/^\d/.test(body) && /^\d/.test(s[close + 1] ?? ""));
        if (isMath) {
          spans.push({ kind: "math", start: i, end: close + 1, body });
          i = close + 1;
          continue;
        }
      }
      const m = s.slice(i + 1).match(CURRENCY_RE);
      if (m) {
        spans.push({ kind: "currency", start: i, end: i + 1 + m[0].length, body: m[0] });
        i += 1 + m[0].length;
        continue;
      }
      spans.push({ kind: "dollar", start: i, end: i + 1, body: "" });
      i += 1;
      continue;
    }
    i++;
  }
  return spans;
}

/** Index of the next `$` that is neither escaped nor half of a `$$`, or -1. */
function nextSingleDollar(s: string, from: number): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] !== "$") continue;
    if (s[j - 1] === "\\") continue;
    if (s[j + 1] === "$") {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// TeX → words. A light verbalizer for the short inline math the tutor writes
// ($\hat y$, $v_{\text{king}}$, $\partial L / \partial a$). Unknown commands
// are spoken by name and noted.
// ---------------------------------------------------------------------------

const GREEK = new Set([
  "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa",
  "lambda", "mu", "nu", "xi", "omicron", "pi", "rho", "sigma", "tau", "upsilon", "phi",
  "chi", "psi", "omega",
]);

const TEX_WORDS: Record<string, string> = {
  varepsilon: "epsilon", vartheta: "theta", varphi: "phi", varrho: "rho", varsigma: "sigma",
  partial: "partial", nabla: "grad", cdot: "times", times: "times", div: "divided by",
  approx: "is approximately", neq: "is not equal to", ne: "is not equal to",
  leq: "is less than or equal to", le: "is less than or equal to",
  geq: "is greater than or equal to", ge: "is greater than or equal to",
  ll: "is much less than", gg: "is much greater than", equiv: "is equivalent to",
  propto: "is proportional to", sim: "tilde", to: "to", rightarrow: "to", mapsto: "maps to",
  leftarrow: "from", Rightarrow: "implies", implies: "implies", iff: "if and only if",
  infty: "infinity", sum: "the sum of", prod: "the product of", int: "the integral of",
  lim: "the limit of", log: "log", ln: "log", exp: "exp", max: "max", min: "min",
  argmax: "arg max", argmin: "arg min", arg: "arg", sin: "sine", cos: "cosine", tan: "tangent",
  tanh: "tanh", det: "determinant of", Pr: "probability of", in: "in", notin: "not in",
  subset: "subset of", subseteq: "subset of", cup: "union", cap: "intersect",
  forall: "for all", exists: "there exists", mid: "given", pm: "plus or minus",
  dots: "and so on", ldots: "and so on", cdots: "and so on", vdots: "and so on",
  top: "transpose", intercal: "transpose", circ: "composed with", odot: "elementwise times",
  otimes: "tensor", oplus: "direct sum", ell: "ell", prime: "prime", star: "star",
  emptyset: "the empty set", neg: "not", land: "and", lor: "or", cdotp: "times",
  "%": "percent", "&": "and", "#": "number", $: "dollars",
};

// Commands whose argument is simply spoken (styling wrappers).
const TEX_UNWRAP = new Set([
  "text", "textrm", "textit", "textbf", "mathrm", "mathbf", "mathit", "mathsf", "mathtt",
  "mathcal", "mathbb", "mathfrak", "operatorname", "boldsymbol", "bm", "mbox", "emph",
]);

// Accents, spoken after their argument: \hat y → "y hat".
const TEX_ACCENTS: Record<string, string> = {
  hat: "hat", widehat: "hat", bar: "bar", overline: "bar", tilde: "tilde", widetilde: "tilde",
  vec: "vector", dot: "dot", ddot: "double dot",
};

// Commands that carry no spoken content at all.
const TEX_SILENT = new Set([
  "left", "right", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr",
  "quad", "qquad", "displaystyle", "textstyle", "limits", "nolimits", "langle", "rangle",
  "lvert", "rvert", "lVert", "rVert", "vert", "Vert", "{", "}", ",", ";", ":", "!", " ",
  "lbrace", "rbrace", "lfloor", "rfloor", "lceil", "rceil",
]);

/** Read one TeX argument at `i`: a braced group, a command, or one character. */
function texArg(src: string, i: number): [string, number] {
  while (src[i] === " ") i++;
  if (i >= src.length) return ["", i];
  if (src[i] === "{") {
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) return [src.slice(i + 1, j), j + 1];
    }
    return [src.slice(i + 1), src.length];
  }
  if (src[i] === "\\") {
    const m = src.slice(i + 1).match(/^([A-Za-z]+|.)/);
    const len = m ? m[0].length : 0;
    return [src.slice(i, i + 1 + len), i + 1 + len];
  }
  return [src[i], i + 1];
}

function superscript(raw: string, notes: string[]): string {
  const r = raw.trim();
  if (r === "2") return "squared";
  if (r === "3") return "cubed";
  if (r === "T" || r === "\\top" || r === "\\intercal" || r === "\\mathsf{T}") return "transpose";
  if (r === "-1") return "inverse";
  if (r === "*" || r === "\\star" || r === "\\ast") return "star";
  if (r === "\\prime" || r === "'") return "prime";
  const paren = r.match(/^\((.*)\)$/);
  if (paren) return `superscript ${texToWords(paren[1], notes)}`;
  return `to the ${texToWords(r, notes)}`;
}

/** Speak a TeX string as words. Exported for tests and the speech audit. */
export function texToWords(src: string, notes: string[] = []): string {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      const m = src.slice(i + 1).match(/^([A-Za-z]+|.)/);
      const name = m ? m[0] : "";
      i += 1 + name.length;
      if (name === "" || name === "\\") {
        out.push(",");
        continue;
      }
      if (TEX_UNWRAP.has(name)) {
        const [arg, j] = texArg(src, i);
        i = j;
        out.push(texToWords(arg, notes));
        continue;
      }
      if (name === "frac" || name === "dfrac" || name === "tfrac") {
        const [a, j] = texArg(src, i);
        const [b, k] = texArg(src, j);
        i = k;
        out.push(`${texToWords(a, notes)} over ${texToWords(b, notes)}`);
        continue;
      }
      if (name === "sqrt") {
        let index = "";
        if (src[i] === "[") {
          const close = src.indexOf("]", i);
          if (close !== -1) {
            index = src.slice(i + 1, close);
            i = close + 1;
          }
        }
        const [arg, j] = texArg(src, i);
        i = j;
        const inner = texToWords(arg, notes);
        out.push(index ? `the root ${texToWords(index, notes)} of ${inner}` : `the square root of ${inner}`);
        continue;
      }
      if (name in TEX_ACCENTS) {
        const [arg, j] = texArg(src, i);
        i = j;
        out.push(`${texToWords(arg, notes)} ${TEX_ACCENTS[name]}`);
        continue;
      }
      if (TEX_SILENT.has(name)) continue;
      if (GREEK.has(name.toLowerCase())) {
        out.push(name.toLowerCase());
        continue;
      }
      if (name in TEX_WORDS) {
        out.push(TEX_WORDS[name]);
        continue;
      }
      if (/^[A-Za-z]+$/.test(name)) {
        notes.push(`tex:unknown \\${name}`);
        out.push(name);
      }
      continue;
    }
    if (c === "^") {
      const [arg, j] = texArg(src, i + 1);
      i = j;
      out.push(superscript(arg, notes));
      continue;
    }
    if (c === "_") {
      const [arg, j] = texArg(src, i + 1);
      i = j;
      out.push(`sub ${texToWords(arg, notes)}`);
      continue;
    }
    if (c === "{") {
      const [arg, j] = texArg(src, i);
      i = j;
      out.push(texToWords(arg, notes));
      continue;
    }
    i++;
    switch (c) {
      case "=": out.push("equals"); break;
      case "+": out.push("plus"); break;
      case "-": out.push("minus"); break;
      case "*": out.push("times"); break;
      case "/": out.push("over"); break;
      case "<": out.push("is less than"); break;
      case ">": out.push("is greater than"); break;
      case "!": out.push("factorial"); break;
      case "'": out.push("prime"); break;
      case ",": out.push(","); break;
      case ".": out.push("."); break;
      case "(": case ")": case "[": case "]": case "|": case "}": case "&": case "~":
        out.push(" ");
        break;
      default: {
        const num = src.slice(i - 1).match(/^\d+(?:\.\d+)?/);
        if (num) {
          i += num[0].length - 1;
          out.push(num[0]);
          break;
        }
        // Juxtaposed capitals are separate variables (QK → "Q K"); a longer
        // word ("softmax", "loss") is kept whole.
        const run = src.slice(i - 1).match(/^[A-Za-z]+/);
        if (run) {
          const w = run[0];
          i += w.length - 1;
          out.push(w.length <= 3 && w === w.toUpperCase() && w.length > 1 ? w.split("").join(" ") : w);
        } else {
          out.push(c);
        }
      }
    }
  }
  return tidy(out.join(" "));
}

// ---------------------------------------------------------------------------
// Plain-text cleanup
// ---------------------------------------------------------------------------

const UNICODE_WORDS: [RegExp, string][] = [
  [/√/g, " the square root of "],
  [/≈/g, " approximately "],
  [/≠/g, " not equal to "],
  [/≤/g, " less than or equal to "],
  [/≥/g, " greater than or equal to "],
  [/±/g, " plus or minus "],
  [/∞/g, " infinity "],
  [/∑/g, " the sum of "],
  [/∂/g, " partial "],
  [/∇/g, " grad "],
  [/∈/g, " in "],
  [/⇒/g, " implies "],
  [/[→⟶]/g, " to "],
  [/←/g, " from "],
  [/[×·]/g, " times "],
  [/−/g, "-"],
  [/α/g, " alpha "], [/β/g, " beta "], [/γ/g, " gamma "], [/δ/g, " delta "],
  [/ε/g, " epsilon "], [/η/g, " eta "], [/θ/g, " theta "], [/λ/g, " lambda "],
  [/μ/g, " mu "], [/π/g, " pi "], [/σ/g, " sigma "], [/τ/g, " tau "],
  [/φ/g, " phi "], [/ω/g, " omega "], [/Δ/g, " delta "], [/Σ/g, " sigma "],
];

/** Collapse whitespace and repair spacing around punctuation. */
function tidy(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
    .replace(/^[\s,;:]+/, "")
    .trim();
}

function symbols(s: string, notes: string[]): string {
  let t = s
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ") // stray HTML tags (<br>, <sup>…)
    .replace(/(\d)\s*–\s*(\d)/g, "$1 to $2")
    .replace(/\s*[—–]\s*|\s+--\s+/g, ", ")
    .replace(/\s*(?:->|=>)\s*/g, " to ")
    .replace(/\s*>=\s*/g, " greater than or equal to ")
    .replace(/\s*<=\s*/g, " less than or equal to ")
    .replace(/\s+>\s+/g, " greater than ")
    .replace(/\s+<\s+/g, " less than ")
    .replace(/\s+\*\s+/g, " times ")
    .replace(/&/g, " and ")
    .replace(/~(?=\d)/g, "about ")
    .replace(/#(?=\d)/g, "number ");
  for (const [re, word] of UNICODE_WORDS) t = t.replace(re, word);
  t = t
    .replace(/(\w)\^T\b/g, "$1 transpose")
    .replace(/\^2\b/g, " squared")
    .replace(/\^3\b/g, " cubed")
    .replace(/\^\(?-1\)?/g, " inverse")
    .replace(/\^/g, " to the ")
    .replace(/(\w)_(?=\w)/g, "$1 ");
  // Brackets carry no sound of their own; drop them quietly.
  t = t.replace(/[[\]{}]/g, " ");
  // Whatever is left is a sigil the rules above didn't anticipate. Strip it so
  // the voice never says "asterisk", but record it — that's a gap to close.
  for (const ch of ["*", "#", "|", "\\", "_", "`", "~", "$", "<", ">"]) {
    if (t.includes(ch)) {
      notes.push(`stripped:${ch}`);
      t = t.split(ch).join(" ");
    }
  }
  return t;
}

// ---------------------------------------------------------------------------
// Inline markdown → words
// ---------------------------------------------------------------------------

function currencyWords(body: string): string {
  const m = body.match(CURRENCY_RE);
  if (!m) return `${body} dollars`;
  const scale = (m[2] ?? "").trim();
  const scaleWord =
    scale === "k" || scale === "K" ? "thousand"
      : scale === "M" ? "million"
        : scale === "B" || scale === "bn" ? "billion"
          : scale;
  return scaleWord ? `${m[1]} ${scaleWord} dollars` : `${m[1]} dollars`;
}

function codeWords(body: string, notes: string[]): string {
  // Formula-looking code (`softmax(QK^T/√d_k)`) reads better through the TeX
  // verbalizer; identifiers (`max_len`) just lose their underscores.
  if (/[\\^√]/.test(body)) return texToWords(body.replace(/√/g, "\\sqrt "), notes);
  return body.replace(/(\w)_(?=\w)/g, "$1 ");
}

function textWords(s: string, notes: string[]): string {
  let t = s
    .replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, "$1") // markdown escapes: \* → *
    .replace(/_{3,}/g, " blank ") // fill-in-the-blank: "the water is ___"
    .replace(/!\[[^\]]*\]\([^)]*\)/g, () => {
      notes.push("placeholder:image");
      return ` ${PLACEHOLDER.image} `;
    })
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1") // [text][ref] → text
    .replace(/<https?:\/\/[^>]*>/gi, "a link")
    .replace(/https?:\/\/[^\s)]+/gi, "a link")
    // Bold markers can straddle a math or code span ("**the $x$ term**"),
    // which splits them across text segments — so drop them outright rather
    // than matching pairs. Outside spans, ** is never anything but emphasis.
    .replace(/\*{2,3}/g, "")
    .replace(/__(.+?)__/g, "$1")
    // Single-* and _ italics, matched per marker rather than per pair for the
    // same straddling reason. A * with space on both sides is multiplication
    // (symbols() says "times"); a _ between word characters is snake_case.
    .replace(/(?<!\s)\*|\*(?!\s)/g, "")
    .replace(/(?<!\w)_+|_+(?!\w)/g, "")
    .replace(/~~(.+?)~~/g, "$1");
  t = symbols(t, notes);
  return t;
}

/** One line (or joined paragraph) of inline markdown → words. */
export function inlineToSpeech(s: string, notes: string[] = []): string {
  const parts: string[] = [];
  let pos = 0;
  for (const sp of inlineSpans(s)) {
    if (sp.start > pos) parts.push(textWords(s.slice(pos, sp.start), notes));
    switch (sp.kind) {
      case "code":
        parts.push(codeWords(sp.body, notes));
        break;
      case "math":
        parts.push(texToWords(sp.body, notes));
        break;
      case "display":
        notes.push("placeholder:equation");
        parts.push(PLACEHOLDER.equation);
        break;
      case "currency":
        parts.push(currencyWords(sp.body));
        break;
      case "dollar":
        break; // a stray sign — nothing to say
    }
    pos = sp.end;
  }
  if (pos < s.length) parts.push(textWords(s.slice(pos), notes));
  // A dash between two prices is a range: "$5-$10" → "5 dollars to 10 dollars".
  return tidy(parts.join(" ").replace(/\bdollars\s*[-–]\s*(?=\d)/g, "dollars to "));
}

// ---------------------------------------------------------------------------
// Block markdown → words
// ---------------------------------------------------------------------------

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w-]*)/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

const NUMBER_WORDS = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
  "Eighteen", "Nineteen", "Twenty",
];

function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/** End a spoken unit with punctuation so the voice pauses before the next. */
function ensureStop(s: string): string {
  return /[\p{L}\p{N})"'”’%]$/u.test(s) ? `${s}.` : s;
}

interface ListLevel {
  indent: number;
  ordered: boolean;
  count: number;
}

/** A block of markdown (one or more paragraphs) → text for the voice. */
export function toSpeech(md: string): Speech {
  const notes: string[] = [];
  const out: string[] = [];
  const lines = md.replace(/\r/g, "").split("\n");
  let para: string[] = [];
  let list: ListLevel[] = [];
  let item: { prefix: string; text: string[] } | null = null;

  const flushPara = () => {
    if (para.length) {
      const t = inlineToSpeech(para.join(" "), notes);
      if (t) out.push(ensureStop(t));
      para = [];
    }
  };
  const flushItem = () => {
    if (item) {
      const t = inlineToSpeech(item.text.join(" "), notes);
      const spoken = [item.prefix, t].filter(Boolean).join(" ");
      if (spoken) out.push(ensureStop(spoken));
      item = null;
    }
  };
  const endList = () => {
    flushItem();
    list = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const fence = line.match(FENCE_RE);
    if (fence) {
      flushPara();
      endList();
      const marker = fence[1];
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith(marker)) j++;
      i = j; // skip past the closing fence (or to the end if unclosed)
      const isDiagram = fence[2].toLowerCase() === "mermaid";
      notes.push(isDiagram ? "placeholder:diagram" : "placeholder:code");
      out.push(isDiagram ? PLACEHOLDER.diagram : PLACEHOLDER.code);
      continue;
    }

    if (trimmed.startsWith("$$") || trimmed.startsWith("\\[")) {
      const closer = trimmed.startsWith("$$") ? "$$" : "\\]";
      const rest = trimmed.slice(2);
      if (!rest.includes(closer)) {
        let j = i + 1;
        while (j < lines.length && !lines[j].includes(closer)) j++;
        i = j;
      }
      flushPara();
      endList();
      notes.push("placeholder:equation");
      out.push(PLACEHOLDER.equation);
      continue;
    }

    const isTableRow = trimmed.startsWith("|") && trimmed.length > 1;
    const startsHeaderlessTable = !isTableRow && trimmed.includes("|") && TABLE_SEP_RE.test(lines[i + 1] ?? "");
    if (isTableRow || startsHeaderlessTable) {
      flushPara();
      endList();
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "" && (lines[j].includes("|") || TABLE_SEP_RE.test(lines[j]))) j++;
      i = j - 1;
      notes.push("placeholder:table");
      out.push(PLACEHOLDER.table);
      continue;
    }

    if (trimmed === "") {
      flushPara();
      flushItem(); // a loose list continues after a blank line; the item ends
      continue;
    }

    if (HR_RE.test(line)) {
      flushPara();
      endList();
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      flushPara();
      endList();
      const t = inlineToSpeech(heading[1], notes);
      if (t) out.push(ensureStop(t));
      continue;
    }

    const li = line.match(LIST_RE);
    if (li) {
      flushPara();
      flushItem();
      const indent = li[1].replace(/\t/g, "    ").length;
      const ordered = /\d/.test(li[2]);
      let nestedStart = false;
      if (list.length === 0 || indent > list[list.length - 1].indent) {
        nestedStart = list.length > 0;
        list.push({ indent, ordered, count: 0 });
      } else {
        while (list.length > 1 && list[list.length - 1].indent > indent) list.pop();
        // A marker change at the same depth ("-" then "1.") starts a new list.
        const top = list[list.length - 1];
        if (top.ordered !== ordered) {
          list[list.length - 1] = { indent, ordered, count: 0 };
        }
      }
      const level = list[list.length - 1];
      level.count++;
      const text = li[3].replace(/^\[[ xX]\]\s+/, ""); // task-list box
      const prefix = [
        nestedStart ? NESTED_INTRO : "",
        level.ordered ? `${numberWord(level.count)},` : "",
      ]
        .filter(Boolean)
        .join(" ");
      item = { prefix, text: [text] };
      continue;
    }

    // Indented text inside a list continues the current item (or the list).
    if (list.length > 0 && /^\s+\S/.test(line)) {
      if (item) item.text.push(trimmed);
      else item = { prefix: "", text: [trimmed] };
      continue;
    }

    if (list.length > 0) endList();
    para.push(trimmed.replace(/^(>\s?)+/, "")); // blockquote markers
  }
  flushPara();
  endList();

  return { text: tidy(out.join(" ")), notes };
}

// ---------------------------------------------------------------------------
// Sentence ends — the splitter the chunker uses inside long paragraphs.
// ---------------------------------------------------------------------------

// Words after which a period does not end a sentence. Matched case-sensitively
// on the word before the period ("No. 5" vs "say no. Then").
const ABBREVIATIONS = new Set([
  "Dr", "Mr", "Mrs", "Ms", "Prof", "Sr", "Jr", "St", "Fig", "Figs", "Eq", "Eqs", "No", "Vol",
  "vs", "etc", "cf", "al", "approx", "e.g", "i.e", "eg", "ie", "Ch", "Sec", "p", "pp",
]);

/**
 * Index just past the first sentence end in `line` at or after `min`, or -1.
 * The returned index is the start of the next sentence, and is only returned
 * once that sentence's first character has arrived — so for a streaming line
 * the answer never changes as more text is appended (the chunker relies on
 * this to produce identical chunks however the text was split into deltas).
 */
export function firstSentenceEnd(line: string, min = 0): number {
  const spans = inlineSpans(line);
  const inSpan = (k: number) => spans.some((s) => k >= s.start && k < s.end);
  let depthParen = 0;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (inSpan(k)) continue;
    if (c === "(") depthParen++;
    else if (c === ")") depthParen = Math.max(0, depthParen - 1);
    if (c !== "." && c !== "!" && c !== "?") continue;
    // Closing punctuation that belongs to the sentence ("…end." or …end.)).
    let e = k + 1;
    while (e < line.length && /["'”’)\]*_]/.test(line[e])) e++;
    if (e >= line.length || !/\s/.test(line[e])) continue;
    let n = e;
    while (n < line.length && /\s/.test(line[n])) n++;
    if (n >= line.length) continue; // next sentence hasn't started yet
    if (!/[A-Z0-9"'“‘(*$\[_`\\]/.test(line[n])) continue;
    if (c === ".") {
      const word = line.slice(0, k).match(/([A-Za-z.]+)$/)?.[1] ?? "";
      if (ABBREVIATIONS.has(word)) continue;
      if (/^[A-Za-z]$/.test(word)) continue; // an initial: "J. Smith"
    }
    if (depthParen > 0 && line[e - 1] !== ")") continue; // mid-parenthetical
    if (n >= min) return n;
  }
  return -1;
}

/** Split a paragraph into sentences with the same rules (for tests/audits). */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  for (;;) {
    const k = firstSentenceEnd(rest, 1);
    if (k === -1) break;
    out.push(rest.slice(0, k).trim());
    rest = rest.slice(k);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

// ---------------------------------------------------------------------------
// The streaming chunker
// ---------------------------------------------------------------------------

export interface ChunkerOptions {
  /** Don't cut at a block boundary before this many characters (fewer, larger utterances). */
  minChunk?: number;
  /** Cut a long paragraph at a sentence end once the chunk reaches this length. */
  longChunk?: number;
}

export const DEFAULT_MIN_CHUNK = 120;
export const DEFAULT_LONG_CHUNK = 350;

/**
 * Earliest safe cut in a streaming markdown buffer, or -1.
 *
 * Safe means: a block boundary (a blank line followed by content, or a
 * heading) outside any code fence or display-math block, never inside a list
 * (loose lists have blank lines between items), and at least `minChunk` in;
 * or, inside an ordinary paragraph, a sentence end at least `longChunk` in.
 *
 * Every decision depends only on text already in the buffer up to a bounded
 * look-ahead, and the earliest qualifying cut always wins — so the same
 * message produces the same chunks whether it arrived whole or one character
 * at a time.
 */
export function findCut(buf: string, minChunk = DEFAULT_MIN_CHUNK, longChunk = DEFAULT_LONG_CHUNK): number {
  let fence: string | null = null;
  let mathCloser: string | null = null;
  let listActive = false;
  let prevBlank = false;
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf("\n", pos);
    const complete = nl !== -1;
    const line = buf.slice(pos, complete ? nl : buf.length);
    const trimmed = line.trim();
    const blocky = fence !== null || mathCloser !== null;

    if (pos > 0 && !blocky && trimmed !== "" && pos >= minChunk) {
      // Enough of the line to classify it (list item? heading?).
      const known = complete || line.trimStart().length >= 5;
      const listish = LIST_RE.test(line) || /^\s+\S/.test(line);
      if (prevBlank && (!listActive || (known && !listish))) return pos;
      if (!prevBlank && known && HEADING_RE.test(line)) return pos;
    }

    const isParagraph =
      !blocky &&
      trimmed !== "" &&
      !FENCE_RE.test(line) &&
      !trimmed.startsWith("$$") &&
      !trimmed.startsWith("\\[") &&
      !trimmed.startsWith("|") &&
      !LIST_RE.test(line) &&
      !(listActive && /^\s+\S/.test(line)) &&
      !HEADING_RE.test(line);
    if (isParagraph) {
      const k = firstSentenceEnd(line, Math.max(0, longChunk - pos));
      if (k !== -1) return pos + k;
    }

    if (!complete) break;

    // Update block state from this (complete) line.
    if (fence !== null) {
      if (trimmed.startsWith(fence)) fence = null;
    } else if (mathCloser !== null) {
      if (line.includes(mathCloser)) mathCloser = null;
    } else {
      const f = line.match(FENCE_RE);
      if (f) fence = f[1];
      else if (trimmed.startsWith("$$") && !trimmed.slice(2).includes("$$")) mathCloser = "$$";
      else if (trimmed.startsWith("\\[") && !trimmed.includes("\\]")) mathCloser = "\\]";
      if (LIST_RE.test(line)) listActive = true;
      else if (trimmed !== "" && !/^\s+\S/.test(line)) listActive = false;
    }
    prevBlank = trimmed === "";
    pos = nl + 1;
  }
  return -1;
}

/** One chunk: the markdown slice and what the voice will say for it. */
export interface Chunk extends Speech {
  md: string;
}

export interface Chunker {
  /** Feed streamed text; returns chunks that are now complete. */
  push(delta: string): Chunk[];
  /** The message ended: return whatever is left as a final chunk. */
  flush(): Chunk[];
  /** Markdown received but not yet emitted. */
  readonly pending: string;
  /** Every character fed since the last flush — for the stream-consistency check. */
  readonly received: string;
}

function toChunk(md: string): Chunk | null {
  if (!md.trim()) return null;
  const s = toSpeech(md);
  return s.text ? { md, ...s } : { md, text: "", notes: [...s.notes, "empty"] };
}

/**
 * A per-message chunker. Create one per assistant message; call flush() when
 * that message's `assistant` event arrives (never feed it `ev.text` — that
 * would speak the message twice).
 */
export function createChunker(opts: ChunkerOptions = {}): Chunker {
  const minChunk = opts.minChunk ?? DEFAULT_MIN_CHUNK;
  const longChunk = opts.longChunk ?? DEFAULT_LONG_CHUNK;
  let buf = "";
  let received = "";
  const drain = (): Chunk[] => {
    const out: Chunk[] = [];
    for (;;) {
      const cut = findCut(buf, minChunk, longChunk);
      if (cut <= 0) break;
      const c = toChunk(buf.slice(0, cut));
      buf = buf.slice(cut);
      if (c) out.push(c);
    }
    return out;
  };
  return {
    push(delta: string): Chunk[] {
      buf += delta;
      received += delta;
      return drain();
    },
    flush(): Chunk[] {
      const out = drain();
      const c = toChunk(buf);
      buf = "";
      received = "";
      if (c) out.push(c);
      return out;
    },
    get pending() {
      return buf;
    },
    get received() {
      return received;
    },
  };
}
