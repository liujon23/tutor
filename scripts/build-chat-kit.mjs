// Build the claude.ai "chat edition" kit: uploadable Skill zips plus the
// starter files for a Project. Output goes to exports/chat-edition/
// (gitignored). Run with `npm run build:chat-kit`.
//
// The kit script is chat-edition/kit.ts bundled with its imports (core/ and
// `yaml`) into one tutor-kit.mjs that needs nothing but Node, because the
// chat's sandbox has no node_modules. The teaching contract and document
// formats are copied from .claude/skills/references/, so there's still one source.
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "chat-edition");
const REFS = join(ROOT, ".claude", "skills", "references");
const STARTER = join(ROOT, "examples", "starter-data", "data");
const OUT = join(ROOT, "exports", "chat-edition");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 1. The kit, as one self-contained file.
const kitFile = join(OUT, "tutor-kit.mjs");
await build({
  entryPoints: [join(SRC, "kit.ts")],
  outfile: kitFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  minify: true,
  legalComments: "eof",
  // `yaml`'s CommonJS build calls require(), which an ESM bundle doesn't have.
  banner: {
    js: [
      "// tutor-kit: built from github.com/liujon23/tutor (chat-edition/kit.ts). Run with plain node.",
      'import { createRequire as __tutorCreateRequire } from "node:module";',
      "const require = __tutorCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
});

// 2. Skill folders.
const skills = {
  "tutor-lesson": [
    [join(SRC, "skills", "tutor-lesson", "SKILL.md"), "SKILL.md"],
    [kitFile, "tutor-kit.mjs"],
    [join(REFS, "teaching-contract.md"), "teaching-contract.md"],
    [join(REFS, "document-formats.md"), "document-formats.md"],
  ],
  "tutor-probe": [
    [join(SRC, "skills", "tutor-probe", "SKILL.md"), "SKILL.md"],
    [join(SRC, "skills", "tutor-probe", "probe.mjs"), "probe.mjs"],
    [join(SRC, "skills", "tutor-probe", "probe-patch.json"), "probe-patch.json"],
    [kitFile, "tutor-kit.mjs"],
  ],
};
for (const [name, files] of Object.entries(skills)) {
  const dir = join(OUT, "skills", name);
  mkdirSync(dir, { recursive: true });
  for (const [from, to] of files) copyFileSync(from, join(dir, to));
  writeZip(join(OUT, `${name}.zip`), join(OUT, "skills"), dir);
}

// 3. The Project's starting files, flattened (Projects have no folders).
const proj = join(OUT, "project-files");
mkdirSync(proj, { recursive: true });
for (const f of ["curriculum.yaml", "profile.md", "lesson-history.md"]) copyFileSync(join(STARTER, f), join(proj, f));
const projectsDir = join(STARTER, "projects");
if (existsSync(projectsDir)) {
  for (const f of readdirSync(projectsDir)) {
    if (f.endsWith(".md")) copyFileSync(join(projectsDir, f), join(proj, `project-${f}`));
  }
}
copyFileSync(join(SRC, "project-instructions.md"), join(OUT, "project-instructions.md"));
copyFileSync(join(SRC, "START-HERE.md"), join(OUT, "START-HERE.md"));

const kb = (p) => `${(statSync(p).size / 1024).toFixed(0)} KB`;
console.log(`Built ${relative(ROOT, OUT)}${sep}`);
console.log(`  tutor-kit.mjs      ${kb(kitFile)}`);
for (const name of Object.keys(skills)) console.log(`  ${name}.zip`.padEnd(21) + kb(join(OUT, `${name}.zip`)));
console.log(`  project-files${sep}     ${readdirSync(proj).join(", ")}`);
console.log(`  START-HERE.md, project-instructions.md`);

// ---------------------------------------------------------------------------
// Minimal zip writer (deflate, no dependencies). Entries are stored relative to
// `base`, so a skill zips as tutor-lesson/SKILL.md etc.

function writeZip(zipPath, base, dir) {
  const entries = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else entries.push(p);
    }
  };
  walk(dir);

  const local = [];
  const central = [];
  let offset = 0;
  for (const p of entries) {
    const name = Buffer.from(relative(base, p).split(sep).join("/"), "utf8");
    const data = readFileSync(p);
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt32LE(0, 10); // time/date: zero (reproducible)
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(comp.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, name, comp);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(0, 12);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += head.length + name.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(zipPath, Buffer.concat([...local, cenBuf, end]));
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
