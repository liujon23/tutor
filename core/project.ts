import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-lane project artifact — the design doc a project-bearing lane accretes
 * across lessons. Kept as its own markdown file (not in curriculum.yaml) so the
 * prose stays prose: the packet injects it verbatim and the wrap-up rewrites it
 * whole. Lanes without a project simply have no file, and the packet omits the
 * section.
 */

export function projectPath(projectsDir: string, laneId: string): string {
  return join(projectsDir, `${laneId}.md`);
}

/** The lane's project doc, or null if the lane has none. */
export function readProjectDoc(projectsDir: string, laneId: string): string | null {
  const p = projectPath(projectsDir, laneId);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** Write (create or replace) the lane's project doc, ensuring the dir exists. */
export function writeProjectDoc(projectsDir: string, laneId: string, content: string): void {
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(projectPath(projectsDir, laneId), content, "utf8");
}
