/**
 * Auto-pack: place one bin per item demand on the grid so the layout is
 * transport-safe — every column full ("columns") or every row full ("rows").
 *
 * Full columns means the case splits into full-height strips, each a stack of
 * bins as wide as the strip; full rows is the same problem turned 90°. Items
 * go into strips first-fit (widest first, in a few hundred shuffled orders and
 * orientations); whatever is left is filled by growing bins or by spacer bins.
 * Layouts are scored by total bin perimeter plus a per-bin cost: fewer, more
 * compact bins mean fewer walls to print. Pure — tested in Node.
 */

export interface Demand {
  id: string;
  /** Smallest bin, in grid units; either way round. */
  unitsX: number;
  unitsY: number;
}

export interface Placed {
  /** The demand this bin holds, or null for a spacer. */
  id: string | null;
  col: number;
  row: number;
  unitsX: number;
  unitsY: number;
  /** Grown from this size (as placed) to fill spare grid units. */
  grownFrom: [number, number] | null;
}

export type Rule = "columns" | "rows";
export type Growth = "grow" | "spacers";

export interface PackOption {
  rule: Rule;
  bins: Placed[];
  score: number;
  spacers: number;
  grown: number;
  /** Demands this layout leaves out — only when nothing fits them all. */
  left: string[];
}

export interface PackResult {
  options: PackOption[];
  /** No layout holds every demand; the options are the closest ones (fewest left out). */
  partial: boolean;
  /** Demands that fit no strip arrangement at all (too big for the area). */
  unplaceable: string[];
}

/** Whether a bin of this size fits the print bed (either way round). */
export type FitsBed = (unitsX: number, unitsY: number) => boolean;

interface Entry {
  id: string;
  w: number;
  h: number;
}

interface Strip {
  width: number;
  used: number;
  entries: Entry[];
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One first-fit pass into full-height strips of height H. A demand that doesn't
 * fit either fails the pass (null) or, with `skip`, is left out and listed.
 */
function fillStrips(
  demands: Demand[], W: number, H: number, rand: () => number, jitter: boolean, skip = false,
): { strips: Strip[]; left: string[] } | null {
  const order = demands
    .map((d) => ({ d, key: Math.min(d.unitsX, d.unitsY) * 100 + Math.max(d.unitsX, d.unitsY) + (jitter ? rand() * 120 : 0) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.d);
  const strips: Strip[] = [];
  const left: string[] = [];
  let width = 0;
  for (const d of order) {
    const orients: [number, number][] = [[d.unitsX, d.unitsY], [d.unitsY, d.unitsX]].filter(
      ([w, h]) => h <= H && w <= W,
    ) as [number, number][];
    if (orients.length === 0) {
      if (!skip) return null;
      left.push(d.id);
      continue;
    }
    let best: { strip: Strip; w: number; h: number; waste: number } | null = null;
    for (const strip of strips) {
      for (const [w, h] of orients) {
        if (w > strip.width || strip.used + h > H) continue;
        const waste = (strip.width - w) * h + (jitter ? rand() * 0.5 : 0);
        if (!best || waste < best.waste) best = { strip, w, h, waste };
      }
    }
    if (best) {
      best.strip.entries.push({ id: d.id, w: best.w, h: best.h });
      best.strip.used += best.h;
      continue;
    }
    // New strip: long side down the strip keeps strips narrow, unless shuffled otherwise.
    const narrow = [...orients].sort((a, b) => a[0] - b[0]);
    const [w, h] = jitter && narrow.length > 1 && rand() < 0.3 ? narrow[1] : narrow[0];
    if (width + w > W) {
      if (!skip) return null;
      left.push(d.id);
      continue;
    }
    width += w;
    strips.push({ width: w, used: h, entries: [{ id: d.id, w, h }] });
  }
  return { strips, left };
}

/** Split a spare rectangle into spacer bins that each fit the bed. */
function spacers(col: number, row: number, w: number, h: number, fits: FitsBed): Placed[] {
  const out: Placed[] = [];
  let tw = w;
  while (tw > 1 && !fits(tw, 1)) tw--;
  let th = h;
  while (th > 1 && !fits(tw, th)) th--;
  for (let x = 0; x < w; x += tw) {
    for (let y = 0; y < h; y += th) {
      out.push({ id: null, col: col + x, row: row + y, unitsX: Math.min(tw, w - x), unitsY: Math.min(th, h - y), grownFrom: null });
    }
  }
  return out;
}

/** Turn strips into placed bins on a W × H grid, filling every spare grid unit. */
function finish(strips: Strip[], W: number, H: number, fits: FitsBed, growth: Growth): Placed[] {
  const widths = strips.map((s) => s.width);
  let spare = W - widths.reduce((a, b) => a + b, 0);
  if (spare > 0 && growth === "grow") {
    // Widen the strip with the fewest bins that stays printable.
    const order = strips.map((s, i) => i).sort((a, b) => strips[a].entries.length - strips[b].entries.length);
    for (const i of order) {
      const w = widths[i] + spare;
      const bottom = H - strips[i].used;
      const ok = strips[i].entries.every((e) => fits(w, e.h)) && (bottom === 0 || fits(w, 1));
      if (ok) {
        widths[i] = w;
        spare = 0;
        break;
      }
    }
  }

  const placed: Placed[] = [];
  let col = 0;
  strips.forEach((strip, i) => {
    const w = widths[i];
    const heights = strip.entries.map((e) => e.h);
    let rest = H - strip.used;
    if (rest > 0 && growth === "grow") {
      // Grow the shortest bin that stays printable.
      const order = heights.map((_, k) => k).sort((a, b) => heights[a] - heights[b]);
      const k = order.find((k) => fits(w, heights[k] + rest));
      if (k !== undefined) {
        heights[k] += rest;
        rest = 0;
      }
    }
    let row = 0;
    strip.entries.forEach((e, k) => {
      // Spacer mode keeps the bin at its own width and puts a spacer beside it.
      const bw = growth === "grow" ? w : e.w;
      const grown = bw !== e.w || heights[k] !== e.h;
      placed.push({ id: e.id, col, row, unitsX: bw, unitsY: heights[k], grownFrom: grown ? [e.w, e.h] : null });
      if (bw < w) placed.push(...spacers(col + bw, row, w - bw, heights[k], fits));
      row += heights[k];
    });
    if (rest > 0) placed.push(...spacers(col, row, w, rest, fits));
    col += w;
  });
  if (spare > 0) placed.push(...spacers(col, 0, spare, H, fits));
  return placed;
}

/** Fewer, more compact bins print fewer walls. */
function score(bins: Placed[]): number {
  return bins.reduce((s, b) => s + b.unitsX + b.unitsY + 4, 0);
}

function transpose(bins: Placed[]): Placed[] {
  return bins.map((b) => ({
    ...b,
    col: b.row,
    row: b.col,
    unitsX: b.unitsY,
    unitsY: b.unitsX,
    grownFrom: b.grownFrom ? [b.grownFrom[1], b.grownFrom[0]] : null,
  }));
}

const signature = (bins: Placed[]) =>
  bins.map((b) => `${b.id}:${b.col},${b.row},${b.unitsX},${b.unitsY}`).sort().join("|");

/**
 * Up to two layouts: the best with full columns and the best with full rows,
 * better first. When no layout holds every demand, the closest ones instead:
 * up to three, each leaving out a different set of demands — fewest left out,
 * then the fewest grid units, then score. Leaving out each single demand is
 * tried outright (the usual "one item too many"); passes that skip whatever
 * doesn't fit cover the rest. Deterministic for a seed.
 */
export function autoPack(
  areaX: number,
  areaY: number,
  demands: Demand[],
  fits: FitsBed,
  { growth = "grow", trials = 400, seed = 1 }:
    { growth?: Growth; trials?: number; seed?: number } = {},
): PackResult {
  const fitsArea = (d: Demand) =>
    (d.unitsX <= areaX && d.unitsY <= areaY) || (d.unitsY <= areaX && d.unitsX <= areaY);
  const unplaceable = demands.filter((d) => !fitsArea(d)).map((d) => d.id);
  const usable = demands.filter(fitsArea);
  if (usable.length === 0) return { options: [], partial: false, unplaceable };
  const size = new Map(usable.map((d) => [d.id, d.unitsX * d.unitsY]));
  const leftArea = (o: PackOption) => o.left.reduce((s, id) => s + size.get(id)!, 0);
  const closer = (a: PackOption, b: PackOption) => a.left.length - b.left.length || leftArea(a) - leftArea(b) || a.score - b.score;

  /** Every distinct layout of `pool` found in `n` passes per rule; `left` starts as `out`. */
  const search = (pool: Demand[], n: number, skip: boolean, out: string[] = []) => {
    const found: PackOption[] = [];
    const room = areaX * areaY;
    if (!skip && pool.reduce((s, d) => s + size.get(d.id)!, 0) > room) return found;
    for (const rule of ["columns", "rows"] as Rule[]) {
      const [W, H] = rule === "columns" ? [areaX, areaY] : [areaY, areaX];
      const rand = mulberry32(seed + (rule === "rows" ? 7919 : 0));
      const seen = new Set<string>();
      for (let t = 0; t < n; t++) {
        const filled = fillStrips(pool, W, H, rand, t > 0, skip);
        if (!filled || filled.strips.length === 0) continue;
        let bins = finish(filled.strips, W, H, fits, growth);
        if (rule === "rows") bins = transpose(bins);
        const sig = signature(bins);
        if (seen.has(sig)) continue;
        seen.add(sig);
        found.push({
          rule,
          bins,
          score: score(bins),
          spacers: bins.filter((b) => b.id === null).length,
          grown: bins.filter((b) => b.grownFrom).length,
          left: [...out, ...filled.left],
        });
      }
    }
    return found;
  };

  const full = search(usable, trials, false);
  if (full.length) {
    full.sort((a, b) => a.score - b.score);
    const bestOf = (rule: Rule) => full.find((c) => c.rule === rule);
    const options = [bestOf("columns"), bestOf("rows")].filter((o): o is PackOption => !!o);
    return { options, partial: false, unplaceable };
  }

  const near = [
    ...usable.flatMap((d) => search(usable.filter((x) => x !== d), Math.ceil(trials / 4), false, [d.id])),
    ...search(usable, trials, true),
  ].sort(closer);
  // The best layout for each different set of left-out demands
  const options: PackOption[] = [];
  const sets = new Set<string>();
  for (const o of near) {
    const key = [...o.left].sort().join("|");
    if (sets.has(key)) continue;
    sets.add(key);
    options.push(o);
    if (options.length === 3) break;
  }
  return { options, partial: true, unplaceable };
}
