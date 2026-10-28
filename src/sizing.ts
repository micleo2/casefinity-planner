import type { Bin, Settings } from "./bins.ts";

/**
 * Item → smallest bin. Items are boxes or cylinders; a bin's usable inside is
 * derived from casefinity's bin geometry (bin-common.ts):
 *
 *   width  = n·P − 2·CLEAR − 2·WALL_THICK − (socket boss, if the wall is thinner
 *            than 2·WALL_BUMP: the +X and −Y walls carry WALL_BUMP-deep bosses)
 *   height = OVERALL_HT − FLOOR_THICK
 *
 * scripts/smoke.mjs checks these numbers against the real geometry. Pure — no
 * DOM, no CAD — so it's unit-tested in Node.
 */

export type ItemShape = "box" | "cylinder";
/** Box: "auto" or "as-entered" (height up). Cylinder: "auto", "standing" or "lying". */
export type Orientation = "auto" | "as-entered" | "standing" | "lying";

export interface Item {
  id: string;
  name: string;
  shape: ItemShape;
  /** Box: length × width × height. Cylinder: diameter and height (its length along the axis). */
  length: number;
  width: number;
  height: number;
  diameter: number;
  qty: number;
  orient: Orientation;
}

export function newItem(shape: ItemShape): Item {
  return {
    id: Math.random().toString(36).slice(2, 10),
    name: "",
    shape,
    length: shape === "box" ? 80 : 0,
    width: shape === "box" ? 45 : 0,
    height: shape === "box" ? 30 : 50,
    diameter: shape === "cylinder" ? 50 : 0,
    qty: 1,
    orient: "auto",
  };
}

const bossDepth = (s: Settings) => (s.wallThick < 2 * s.wallBump ? s.wallBump : 0);

/** Usable inside width of a bin `n` grid units wide, mm. */
export function insideWidth(n: number, s: Settings): number {
  return n * s.gridSpacing - 2 * s.clear - 2 * s.wallThick - bossDepth(s);
}

/** Usable inside height (rim to floor) of a bin of the default height, mm. */
export function insideHeight(s: Settings, binHeight = s.overallHeight): number {
  return binHeight - s.floorThick;
}

/** Smallest bin width in grid units with at least `mm` inside, or Infinity. */
export function unitsFor(mm: number, s: Settings): number {
  for (let n = 1; n <= 99; n++) if (insideWidth(n, s) >= mm - 1e-9) return n;
  return Infinity;
}

/** One way to stand the item(s) in a bin. u × v is a single item's footprint. */
export interface Pose {
  u: number;
  v: number;
  z: number;
  /** Copies laid out nx along the bin's X, ny along its Y. */
  nx: number;
  ny: number;
  /** Cylinders: which axis the cylinder's own axis runs along (u is along X). */
  cylAxis: "z" | "u" | null;
  label: string;
}

export interface Sizing {
  ok: true;
  unitsX: number;
  unitsY: number;
  pose: Pose;
  /** Human explanation, one line per fact. */
  explain: string[];
}

export interface SizingError {
  ok: false;
  error: string;
}

const fmt = (n: number) => Number(n.toFixed(1)).toString();

function singlePoses(item: Item): Omit<Pose, "nx" | "ny">[] {
  if (item.shape === "cylinder") {
    const d = item.diameter;
    const h = item.height;
    const standing = { u: d, v: d, z: h, cylAxis: "z" as const, label: "standing" };
    const lying = { u: h, v: d, z: d, cylAxis: "u" as const, label: "lying on its side" };
    if (item.orient === "standing") return [standing];
    if (item.orient === "lying") return [lying];
    return [standing, lying];
  }
  const dims = [item.length, item.width, item.height];
  const sorted = [...dims].sort((a, b) => a - b);
  const label = (z: number) => (z === sorted[0] ? "lying flat" : z === sorted[2] ? "on end" : "on its side");
  const pose = (k: number) => {
    const [u, v] = dims.filter((_, i) => i !== k);
    return { u, v, z: dims[k], cylAxis: null, label: k === 2 && item.orient === "as-entered" ? "as entered" : label(dims[k]) };
  };
  return item.orient === "as-entered" ? [pose(2)] : [pose(2), pose(0), pose(1)];
}

function validate(item: Item): string | null {
  const need = item.shape === "box" ? [item.length, item.width, item.height] : [item.diameter, item.height];
  if (need.some((d) => !(d > 0))) return "Enter all dimensions.";
  if (!(item.qty >= 1)) return "Quantity must be at least 1.";
  return null;
}

/** The smallest bin (by area, then by longest side, then lowest stack) for an item and its quantity. */
export function sizeItem(item: Item, s: Settings): Sizing | SizingError {
  const invalid = validate(item);
  if (invalid) return { ok: false, error: invalid };
  const play = s.itemPlay;
  const maxZ = insideHeight(s);
  const qty = Math.round(item.qty);

  let best: { ux: number; uy: number; pose: Pose } | null = null;
  let tallest = Infinity;
  for (const p of singlePoses(item)) {
    tallest = Math.min(tallest, p.z);
    if (p.z > maxZ) continue;
    for (const [u, v] of [[p.u, p.v], [p.v, p.u]]) {
      for (let nx = 1; nx <= qty; nx++) {
        const ny = Math.ceil(qty / nx);
        const ux = unitsFor(nx * u + play, s);
        const uy = unitsFor(ny * v + play, s);
        if (!Number.isFinite(ux) || !Number.isFinite(uy)) continue;
        const pose: Pose = { ...p, u, v, nx, ny, cylAxis: p.cylAxis };
        const key = [ux * uy, Math.max(ux, uy), p.z];
        if (!best || lexLess(key, [best.ux * best.uy, Math.max(best.ux, best.uy), best.pose.z])) {
          best = { ux, uy, pose };
        }
      }
    }
  }
  if (!best) {
    return Number.isFinite(tallest) && tallest > maxZ
      ? { ok: false, error: `Too tall: needs ${fmt(tallest)} mm standing any way, bins have ${fmt(maxZ)} mm inside.` }
      : { ok: false, error: "Too big for any bin." };
  }

  const { ux, uy, pose } = best;
  const gx = pose.nx * pose.u;
  const gy = pose.ny * pose.v;
  const what = item.shape === "cylinder"
    ? `Cylinder ⌀${fmt(item.diameter)} × ${fmt(item.height)}, ${pose.label}`
    : `Box ${pose.label}`;
  const group = qty > 1 ? `${qty} as ${pose.nx} × ${pose.ny}: ` : "";
  const line = (mm: number, n: number) =>
    `${fmt(mm)} + ${fmt(play)} → ${n} grid unit${n > 1 ? "s" : ""} give ${fmt(insideWidth(n, s))} ✓` +
    (n > 1 ? ` (${n - 1} give ${fmt(insideWidth(n - 1, s))} ✗)` : "");
  return {
    ok: true,
    unitsX: ux,
    unitsY: uy,
    pose,
    explain: [
      `${what}: ${group}footprint ${fmt(gx)} × ${fmt(gy)} mm, ${fmt(pose.z)} mm tall (${fmt(maxZ)} inside).`,
      line(gx, ux),
      line(gy, uy),
    ],
  };
}

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** Solids in bin-local mm (origin at the bin's footprint centre, z = 0 at the bed). */
export type Solid =
  | { kind: "box"; cx: number; cy: number; cz: number; sx: number; sy: number; sz: number }
  | { kind: "cyl"; cx: number; cy: number; cz: number; r: number; len: number; axis: "x" | "y" | "z" };

/**
 * Where an item's copies sit inside a bin — or null if they don't fit (e.g. the
 * bin was resized smaller by hand). Tries the sized footprint both ways round,
 * since the packer may have turned the bin.
 */
export function placeInBin(item: Item, sizing: Sizing, bin: Bin, s: Settings): Solid[] | null {
  const { pose } = sizing;
  const play = s.itemPlay;
  const ix = insideWidth(bin.unitsX, s);
  const iy = insideWidth(bin.unitsY, s);
  const iz = insideHeight(s, bin.height ?? s.overallHeight);
  if (pose.z > iz + 1e-9) return null;
  const b = bossDepth(s);
  // The bosses sit inside the +X and −Y walls, so the free space is shifted.
  const ox = -b / 2;
  const oy = b / 2;
  const z0 = s.floorThick;
  for (const turned of [false, true]) {
    const u = turned ? pose.v : pose.u;
    const v = turned ? pose.u : pose.v;
    const nx = turned ? pose.ny : pose.nx;
    const ny = turned ? pose.nx : pose.ny;
    const gx = nx * u;
    const gy = ny * v;
    if (gx + play > ix + 1e-9 || gy + play > iy + 1e-9) continue;
    const solids: Solid[] = [];
    for (let i = 0; i < Math.round(item.qty); i++) {
      const col = i % nx;
      const row = Math.floor(i / nx);
      const cx = ox - gx / 2 + u * (col + 0.5);
      const cy = oy + gy / 2 - v * (row + 0.5);
      if (item.shape === "cylinder") {
        const axis = pose.cylAxis === "z" ? "z" : turned ? "y" : "x";
        const r = item.diameter / 2;
        solids.push({ kind: "cyl", cx, cy, cz: z0 + pose.z / 2, r, len: item.height, axis });
      } else {
        solids.push({ kind: "box", cx, cy, cz: z0 + pose.z / 2, sx: u, sy: v, sz: pose.z });
      }
    }
    return solids;
  }
  return null;
}

export function solidVolume(sol: Solid): number {
  return sol.kind === "box" ? sol.sx * sol.sy * sol.sz : Math.PI * sol.r * sol.r * sol.len;
}

/** Bin's usable inside volume, mm³. */
export function insideVolume(bin: Bin, s: Settings): number {
  return insideWidth(bin.unitsX, s) * insideWidth(bin.unitsY, s) * insideHeight(s, bin.height ?? s.overallHeight);
}
