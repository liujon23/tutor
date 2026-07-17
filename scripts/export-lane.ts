/**
 * Export a curriculum track (lane) to a shareable Markdown file and a PDF.
 * Deterministic: no AI, no network. The document is a pure function of the lane
 * — see core/lane-doc.ts for exactly what is included (human-written content:
 * direction, unit/topic notes verbatim, curated links) and dropped (all
 * state/progress: topic & unit states, lastTouched, nextUp, the prereq graph,
 * internal ids, lane weight).
 *
 * Usage:
 *   npm run export-lane -- --lane sts [--out <dir>] [--md-only] [--clean]
 *
 *   --lane <id>   lane/track id (e.g. sts, ai, art). Required unless --list.
 *   --out <dir>   output directory (default: ./exports)
 *   --md-only     write the .md only, skip the PDF
 *   --clean       outsider-safe: drop all authored notes (the direction, unit and
 *                 topic notes, and link annotations), leaving a clean syllabus —
 *                 track title, units, topics, and reference links only
 *   --list        print the available lane ids and exit
 *
 * PDF rendering shells out to a headless Chrome/Chromium if one can be found,
 * falling back to LibreOffice. Point CHROME_PATH at a browser binary to override
 * discovery. If neither engine is available the .md is still written and the
 * command explains how to produce the PDF.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCurriculum, laneById } from "../core/curriculum.js";
import { renderLaneMarkdown, renderLaneHtml } from "../core/lane-doc.js";
import { DATA_PATHS, ROOT, parseArgs } from "./lib.js";

const args = parseArgs(process.argv.slice(2), {
  lane: undefined,
  out: join(ROOT, "exports"),
  "md-only": undefined,
  clean: undefined,
  list: undefined,
});

const curriculum = loadCurriculum(DATA_PATHS.curriculum);

if (args.list) {
  console.log("Available tracks:");
  for (const l of curriculum.lanes) console.log(`  ${l.id}\t${l.name}`);
  process.exit(0);
}

if (!args.lane) {
  console.error("error: --lane <id> is required. Run with --list to see the available tracks.");
  process.exit(1);
}

const lane = laneById(curriculum, args.lane);
if (!lane) {
  const ids = curriculum.lanes.map((l) => l.id).join(", ");
  console.error(`error: no track with id '${args.lane}'. Available: ${ids}`);
  process.exit(1);
}

const outDir = args.out!;
mkdirSync(outDir, { recursive: true });
const base = join(outDir, `${lane.id}-track`);
const mdPath = `${base}.md`;
const htmlPath = `${base}.html`;
const pdfPath = `${base}.pdf`;

const docOpts = { notes: !args.clean };

writeFileSync(mdPath, renderLaneMarkdown(lane, docOpts), "utf8");
console.log(`markdown → ${mdPath}${args.clean ? " (clean: notes dropped)" : ""}`);

if (args["md-only"]) process.exit(0);

writeFileSync(htmlPath, renderLaneHtml(lane, docOpts), "utf8");

if (renderPdf(htmlPath, pdfPath, outDir)) {
  console.log(`pdf      → ${pdfPath}`);
} else {
  console.error(
    "note: no PDF engine found — wrote the .md and .html only.\n" +
      "      Install Chrome/Chromium or LibreOffice, or set CHROME_PATH to a browser\n" +
      `      binary, then re-run. You can also print ${htmlPath} to PDF from a browser.`
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// PDF rendering — try a headless browser, then LibreOffice. Returns true on
// success. Never throws: a failed PDF must not lose the already-written .md.
// ---------------------------------------------------------------------------

function renderPdf(html: string, pdf: string, dir: string): boolean {
  const chrome = findChrome();
  if (chrome) {
    try {
      execFileSync(
        chrome,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-sandbox",
          "--no-pdf-header-footer",
          `--print-to-pdf=${pdf}`,
          html,
        ],
        { stdio: "pipe" }
      );
      if (existsSync(pdf)) return true;
    } catch (e) {
      console.error(`  (chrome PDF failed: ${firstLine(e)} — trying LibreOffice)`);
    }
  }

  if (findOnPath("libreoffice") || findOnPath("soffice")) {
    const bin = findOnPath("libreoffice") ?? findOnPath("soffice")!;
    try {
      // LibreOffice derives the output name from the input basename, so it lands
      // at <dir>/<lane>-track.pdf — exactly `pdf`.
      execFileSync(bin, ["--headless", "--convert-to", "pdf", "--outdir", dir, html], {
        stdio: "pipe",
      });
      if (existsSync(pdf)) return true;
    } catch (e) {
      console.error(`  (LibreOffice PDF failed: ${firstLine(e)})`);
    }
  }

  return false;
}

function firstLine(e: unknown): string {
  return (e as Error).message.split("\n")[0];
}

/** Locate a Chrome/Chromium binary: CHROME_PATH, then the Playwright browser
 *  cache (already present in web/CI environments), then the system PATH and the
 *  usual per-OS install locations. */
function findChrome(): string | undefined {
  const explicit = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (explicit && existsSync(explicit)) return explicit;

  const fromPlaywright = findPlaywrightChromium();
  if (fromPlaywright) return fromPlaywright;

  const names = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "chrome",
  ];
  for (const n of names) {
    const p = findOnPath(n);
    if (p) return p;
  }

  const guesses = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  return guesses.find((p) => existsSync(p));
}

function findPlaywrightChromium(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  const rel = [
    ["chrome-linux", "chrome"],
    ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ["chrome-win", "chrome.exe"],
  ];
  for (const dir of readdirSync(root)) {
    if (!dir.startsWith("chromium")) continue;
    for (const parts of rel) {
      const p = join(root, dir, ...parts);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

function findOnPath(name: string): string | undefined {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, [name], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .split("\n")[0]
      .trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}
