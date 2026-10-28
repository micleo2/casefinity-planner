/**
 * Auto-pack: place one bin per item demand on the grid so the layout is
 * transport-safe — every column full ("columns") or every row full ("rows").
 *
 * Full columns means the case splits into full-height strips, each a stack of
 * bins as wide as the strip; full rows is the same problem turned 90°. Items
 * go into strips first-fit (widest first, in a few hundred shuffled orders and
 * orientations); whatever is left is filled by growing bins or by spacer bins.
 * Layouts are scored by total bin perimeter plus a per-bin cost: fewer, more
 * compact bins mean fewer walls to print. Neither growth nor spacers may make
 * a bin longer than `maxSpan` (the warp-risk length) unless the item's own bin
 * already is. Pure — tested in Node.
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
}

export interface PackResult {
  options: PackOption[];
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

/** One first-fit pass into full-height strips of height H. Null if wider than W. */
function fillStrips(demands: Demand[], W: number, H: number, rand: () => number, jitter: boolean): Strip[] | null {
  const order = demands
    .map((d) => ({ d, key: Math.min(d.unitsX, d.unitsY) * 100 + Math.max(d.unitsX, d.unitsY) + (jitter ? rand() * 120 : 0) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.d);
  const strips: Strip[] = [];
  let width = 0;
  for (const d of order) {
    const orients: [number, number][] = [[d.unitsX, d.unitsY], [d.unitsY, d.unitsX]].filter(
      ([w, h]) => h <= H && w <= W,
    ) as [number, number][];
    if (orients.length === 0) return null;
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
    if (width + w > W) return null;
    width += w;
    strips.push({ width: w, used: h, entries: [{ id: d.id, w, h }] });
  }
  return strips;
}

/** Split a spare rectangle into spacer bins that each fit the bed and stay under the warp span. */
function spacers(col: number, row: number, w: number, h: number, fits: FitsBed, maxSpan: number): Placed[] {
  const out: Placed[] = [];
  let tw = Math.min(w, maxSpan);
  while (tw > 1 && !fits(tw, 1)) tw--;
  let th = Math.min(h, maxSpan);
  while (th > 1 && !fits(tw, th)) th--;
  for (let x = 0; x < w; x += tw) {
    for (let y = 0; y < h; y += th) {
      out.push({ id: null, col: col + x, row: row + y, unitsX: Math.min(tw, w - x), unitsY: Math.min(th, h - y), grownFrom: null });
    }
  }
  return out;
}

/** Turn strips into placed bins on a W × H grid, filling every spare grid unit. */
function finish(strips: Strip[], W: number, H: number, fits: FitsBed, growth: Growth, maxSpan: number): Placed[] {
  // Growing may not make a bin longer than the warp span, unless it already was.
  const canGrow = (e: Entry, w: number, h: number) =>
    fits(w, h) && Math.max(w, h) <= Math.max(maxSpan, e.w, e.h);
  const widths = strips.map((s) => s.width);
  let spare = W - widths.reduce((a, b) => a + b, 0);
  if (spare > 0 && growth === "grow") {
    // Widen the strip with the fewest bins that stays printable.
    const order = strips.map((s, i) => i).sort((a, b) => strips[a].entries.length - strips[b].entries.length);
    for (const i of order) {
      const w = widths[i] + spare;
      const bottom = H - strips[i].used;
      const ok = strips[i].entries.every((e) => canGrow(e, w, e.h)) && (bottom === 0 || (fits(w, 1) && w <= maxSpan));
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
      const k = order.find((k) => canGrow(strip.entries[k], w, heights[k] + rest));
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
      if (bw < w) placed.push(...spacers(col + bw, row, w - bw, heights[k], fits, maxSpan));
      row += heights[k];
    });
    if (rest > 0) placed.push(...spacers(col, row, w, rest, fits, maxSpan));
    col += w;
  });
  if (spare > 0) placed.push(...spacers(col, 0, spare, H, fits, maxSpan));
  return placed;
}

/** Fewer, more compact bins print fewer walls; bins past the warp span cost extra. */
function score(bins: Placed[], maxSpan: number): number {
  return bins.reduce((s, b) => s + b.unitsX + b.unitsY + 4 + (Math.max(b.unitsX, b.unitsY) > maxSpan ? 12 : 0), 0);
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
 * Up to three layouts: the best with full columns, the best with full rows,
 * and the runner-up of the better rule when it differs. Deterministic for a seed.
 */
export function autoPack(
  areaX: number,
  areaY: number,
  demands: Demand[],
  fits: FitsBed,
  { growth = "grow", trials = 400, seed = 1, maxSpan = Infinity }:
    { growth?: Growth; trials?: number; seed?: number; maxSpan?: number } = {},
): PackResult {
  const fitsArea = (d: Demand) =>
    (d.unitsX <= areaX && d.unitsY <= areaY) || (d.unitsY <= areaX && d.unitsX <= areaY);
  const unplaceable = demands.filter((d) => !fitsArea(d)).map((d) => d.id);
  const usable = demands.filter(fitsArea);
  const area = usable.reduce((s, d) => s + d.unitsX * d.unitsY, 0);
  if (usable.length === 0 || area > areaX * areaY) return { options: [], unplaceable: usable.length ? usable.map((d) => d.id) : unplaceable };

  const candidates: PackOption[] = [];
  for (const rule of ["columns", "rows"] as Rule[]) {
    const [W, H] = rule === "columns" ? [areaX, areaY] : [areaY, areaX];
    const rand = mulberry32(seed + (rule === "rows" ? 7919 : 0));
    const seen = new Set<string>();
    for (let t = 0; t < trials; t++) {
      const strips = fillStrips(usable, W, H, rand, t > 0);
      if (!strips) continue;
      let bins = finish(strips, W, H, fits, growth, maxSpan);
      if (rule === "rows") bins = transpose(bins);
      const sig = signature(bins);
      if (seen.has(sig)) continue;
      seen.add(sig);
      candidates.push({
        rule,
        bins,
        score: score(bins, maxSpan),
        spacers: bins.filter((b) => b.id === null).length,
        grown: bins.filter((b) => b.grownFrom).length,
      });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  const bestOf = (rule: Rule) => candidates.find((c) => c.rule === rule);
  const options = [bestOf("columns"), bestOf("rows")].filter((o): o is PackOption => !!o).sort((a, b) => a.score - b.score);
  const runnerUp = candidates.find((c) => !options.includes(c) && c.rule === options[0]?.rule);
  if (runnerUp) options.push(runnerUp);
  options.sort((a, b) => a.score - b.score);
  return { options, unplaceable: candidates.length ? unplaceable : usable.map((d) => d.id).concat(unplaceable) };
}
