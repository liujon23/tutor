// Turn a lane's unit DAG into rows for the curriculum viewer's flowchart.
//
// Pure graph math over the same `prerequisites` edges the validator already
// reasons about — no DOM, no styling decisions, so it can be unit-tested
// directly and reused by the demo-snapshot exporter.
import type { Unit } from "./types.js";

/**
 * Group units into dependency layers: row 0 has everything with no
 * prerequisites, and each later row holds units whose prerequisites are all
 * satisfied by earlier rows.
 *
 * Longest-path (not shortest): a unit sits one row below its *deepest*
 * prerequisite, so an edge never points sideways or backwards and the arrows
 * always read top-to-bottom. Within a row, curriculum.yaml order is preserved —
 * it's author-controlled and stable, which beats anything we'd invent.
 *
 * Two defensive notes. Prerequisites naming a unit outside this list are
 * ignored: the validator reports cross-lane and dangling edges, and this
 * function's job is to draw whatever it's handed. And although the validator
 * guarantees acyclicity, the cycle guard stays — a hand-edited curriculum that
 * hasn't been through `npm run validate` yet must not hang the server.
 */
export function layerUnits(units: Unit[]): string[][] {
  const byId = new Map(units.map((u) => [u.id, u]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  const depthOf = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    // Cycle: break it by treating this node as a root. The validator surfaces
    // the real error; we just refuse to recurse forever.
    if (visiting.has(id)) return 0;

    visiting.add(id);
    let d = 0;
    for (const dep of byId.get(id)?.prerequisites ?? []) {
      if (!byId.has(dep)) continue; // outside this lane, or dangling
      d = Math.max(d, depthOf(dep) + 1);
    }
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };

  const rows: string[][] = [];
  for (const unit of units) {
    const d = depthOf(unit.id);
    (rows[d] ??= []).push(unit.id);
  }
  // A layer can only be empty if no unit landed at that depth, which the
  // longest-path rule makes impossible — but normalize anyway so callers can
  // trust every row is populated.
  return rows.filter((r) => r !== undefined && r.length > 0);
}
