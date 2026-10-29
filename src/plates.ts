import type { Bin, Settings } from "./bins.ts";

/**
 * Print plan: number the bins and arrange them onto print-bed
 * plates. Parts print standing, open side up, so each takes its footprint
 * including the ribs (n·P − 2c + rib depth on each axis), turned 90° on the bed
 * when that fits better. Free-rectangle (guillotine) packing, largest first.
 * Pure — tested in Node.
 */

export interface PlatePart {
  binId: string;
  num: number;
  /** Bed position of the part's footprint, mm, from the bed's back-left corner (x right, y toward the front). */
  x: number;
  y: number;
  /** Footprint on the bed after turning, mm. */
  w: number;
  h: number;
  /** Turned 90° on the bed. */
  turned: boolean;
}

export interface Plate {
  parts: PlatePart[];
}

export interface PlatePlan {
  plates: Plate[];
  /** Bins whose footprint is bigger than the bed either way round. */
  tooBig: string[];
}

/** Part numbers: back row first, left to right. */
export function binNumbers(bins: Bin[]): Map<string, number> {
  const order = [...bins].sort((a, b) => a.row - b.row || a.col - b.col);
  return new Map(order.map((b, i) => [b.id, i + 1]));
}

/** Footprint of a printed bin including its ribs, mm. */
export function partFootprint(bin: Bin, s: Settings): [number, number] {
  return [bin.unitsX * s.gridSpacing - 2 * s.clear + s.wallBump, bin.unitsY * s.gridSpacing - 2 * s.clear + s.wallBump];
}

interface Free {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function planPlates(bins: Bin[], s: Settings, { margin = 5, gap = 5 } = {}): PlatePlan {
  const nums = binNumbers(bins);
  // Each part claims its footprint plus one gap; the usable bed gains one gap back.
  const W = s.bedX - 2 * margin + gap;
  const H = s.bedY - 2 * margin + gap;
  const parts = bins.map((b) => ({ bin: b, size: partFootprint(b, s) }));
  const fitsBed = ([w, h]: [number, number]) => (w + gap <= W && h + gap <= H) || (h + gap <= W && w + gap <= H);
  const tooBig = parts.filter((p) => !fitsBed(p.size)).map((p) => p.bin.id);
  const queue = parts
    .filter((p) => fitsBed(p.size))
    .sort((a, b) => Math.max(...b.size) - Math.max(...a.size) || b.size[0] * b.size[1] - a.size[0] * a.size[1]);

  const plates: { plate: Plate; free: Free[] }[] = [];
  for (const { bin, size } of queue) {
    let placed = false;
    for (const p of plates) {
      if (place(p, bin, size)) {
        placed = true;
        break;
      }
    }
    if (!placed) {
      const p = { plate: { parts: [] as PlatePart[] }, free: [{ x: 0, y: 0, w: W, h: H }] };
      place(p, bin, size);
      plates.push(p);
    }
  }

  function place(p: { plate: Plate; free: Free[] }, bin: Bin, [bw, bh]: [number, number]): boolean {
    let best: { i: number; w: number; h: number; turned: boolean; waste: number } | null = null;
    p.free.forEach((f, i) => {
      for (const turned of [false, true]) {
        const w = (turned ? bh : bw) + gap;
        const h = (turned ? bw : bh) + gap;
        if (w > f.w + 1e-9 || h > f.h + 1e-9) continue;
        const waste = Math.min(f.w - w, f.h - h);
        if (!best || waste < best.waste) best = { i, w, h, turned, waste };
      }
    });
    if (!best) return false;
    const { i, w, h, turned } = best as { i: number; w: number; h: number; turned: boolean };
    const f = p.free[i];
    p.plate.parts.push({ binId: bin.id, num: nums.get(bin.id)!, x: margin + f.x, y: margin + f.y, w: w - gap, h: h - gap, turned });
    // Guillotine split along the shorter leftover
    const right: Free = { x: f.x + w, y: f.y, w: f.w - w, h: 0 };
    const below: Free = { x: f.x, y: f.y + h, w: 0, h: f.h - h };
    if (f.w - w < f.h - h) {
      right.h = h;
      below.w = f.w;
    } else {
      right.h = f.h;
      below.w = w;
    }
    p.free.splice(i, 1, ...[right, below].filter((r) => r.w > 0 && r.h > 0));
    return true;
  }

  for (const { plate } of plates) plate.parts.sort((a, b) => a.num - b.num);
  return { plates: plates.map((p) => p.plate), tooBig };
}
