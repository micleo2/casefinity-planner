import { draw } from "replicad";
import type { Drawing } from "replicad";
import type { ParamDef, ParamValues } from "./types.ts";

/**
 * The Casefinity registration interface — the single source of truth for the
 * dimensions that make independently designed parts interoperate (spec §2 and
 * §4: INV-1, INV-2, REQ-4.1, REQ-4.4). Bins (`bin-common.ts`) and the liner
 * (`perimeter.ts`) derive every rib/slot/boss width and every feature centre
 * from here, so a change to the interface is made in one place. WALL_THICK
 * deliberately enters only through the REQ-4.4 boss rule — never a mating
 * width (INV-2).
 */

/** The interface constant `w` (spec §2): the width of every male rib and the
 * basis of every female slot width. Shared by all bin variants and the liner.
 * No Fusion name: the originals drove this off WALL_THICK (numerically equal
 * at 1.2 mm); the generator freezes it as its own interface constant.
 *
 * Deliberate deviation from the ground truth: the default is 3 mm, not the
 * originals' 1.2 mm. At 1.2 mm a rib is a single extrusion wide on a 0.4 mm
 * nozzle — fragile, and prone to under-extrusion; 3 mm gives it real
 * cross-section. Bins and the liner read this one value, so they still
 * interlock (spec INV-1) — set it back to 1.2 to reproduce the original
 * geometry. See README "Intentional deviations from the ground truth".
 *
 * The 4.5 mm ceiling keeps a bin inside its nominal footprint. A socket's
 * backing boss is `s + 2w = 3w + 2c` wide and sits on the outermost module
 * centre, which leaves only `P/2 - CLEAR` = 7.4 mm to the footprint edge at the
 * standard 15 mm pitch: the boss starts overhanging (and the bin stops tiling)
 * above w = 4.87. Measured — the bbox is exact at 4.8 and grows at 5. */
export const ribWidthParam: ParamDef = { key: "ribWidth", label: "Grid bump width", default: 3, unit: "mm", min: 0.6, max: 4.5, step: 0.1 };

/** Plan-view draft on every registration feature, taken about the wall's
 * NORMAL — not about Z. The features are full-height vertical prisms, so a 2°
 * taper along Z would eat `2 * 110 * tan 2° = 3.84 mm` of width on a default
 * bin, more than a 3 mm rib has; drafting along Z is only possible at a
 * height-dependent angle. About the normal the same 2° costs
 * `2 * b * tan 2° = 0.10 mm` over a 1.5 mm bump, so ribs narrow slightly
 * toward their tip and slots flare slightly at the mouth — a lead-in.
 *
 * No Fusion name: like RIB_WIDTH this is a generator interface constant, not a
 * recovered user parameter. The originals have no draft; set this to 0 to
 * reproduce their geometry exactly (which is what smoke.mjs does to keep its
 * volumes pinned to the STEP ground truth). See docs/models.md "Intentional
 * deviations from the originals". */
export const draftAngleParam: ParamDef = { key: "draftAngle", label: "Bump draft", default: 2, unit: "deg", min: 0, max: 5, step: 0.5 };

/** A drafted registration feature in plan view, in the frame of the wall that
 * carries it. See `draftedProfile`. */
export interface DraftedFeature {
  /** The wall's normal axis; `width` runs along the other one. */
  axis: "X" | "Y";
  /** The feature's extent on `axis`, either order. */
  from: number;
  to: number;
  /** Coordinate on `axis` where `width` is nominal — the wall face. */
  face: number;
  /** Sign on `axis` of the direction the feature narrows in: a rib narrows
   * toward its tip, a female slot toward the bottom of its pocket. */
  narrow: 1 | -1;
  /** Nominal width at `face`. */
  width: number;
  /** The feature's centre on the other axis — a module centre (REQ-3.4). */
  at: number;
}

/**
 * The plan-view trapezoid of a drafted feature: `width` wide at the wall face,
 * narrowing by `2 * tan(draft)` per mm as it extends past that face and
 * widening at the same rate behind it. ONE linear taper across the whole
 * prism, never a taper plus a straight run — that is what keeps the fit exact.
 *
 * A rib's root and its mating slot's mouth are coplanar when two wall faces
 * touch, so both widths shrink identically with depth `d` past that plane and
 * `slot(d) - rib(d) = s - w = 2c` at EVERY depth: the REQ-4.1 locating
 * clearance and the REQ-4.2 line-to-line groove are unchanged, and the draft is
 * purely a lead-in. It also means a drafted part mates with an undrafted one
 * in either direction, so the angle needs no agreement between parts (INV-1).
 *
 * Extrude the result in Z as before — the draft never tilts a feature in Z.
 *
 * The half-width is floored at 0.05 mm: at the parameter extremes (a 0.6 mm rib
 * drafted 5° over a 3 mm bump) the taper would otherwise close the far end to
 * nothing and hand the kernel a degenerate face.
 */
export function draftedProfile(f: DraftedFeature, draftDeg: number): Drawing {
  const k = Math.tan((draftDeg * Math.PI) / 180);
  const half = (n: number) => Math.max(f.width / 2 - (n - f.face) * f.narrow * k, 0.05);
  const h0 = half(f.from);
  const h1 = half(f.to);
  // Corner order traces the quad without self-intersecting, whichever axis is
  // the normal: low-normal/low-width, high-normal/low-width, then back.
  const pt = (n: number, w: number): [number, number] =>
    f.axis === "X" ? [n, f.at + w] : [f.at + w, n];
  return draw(pt(f.from, -h0))
    .lineTo(pt(f.to, -h1))
    .lineTo(pt(f.to, h1))
    .lineTo(pt(f.from, h0))
    .close();
}

/** x/y offsets of module centres, e.g. 3 modules @ 15 → [-15, 0, 15]. Both
 * families centre their features here (REQ-3.4), which is why bin ribs and
 * liner grid bumps coincide when a bin sits on-grid. */
export function moduleCenters(count: number, spacing: number): number[] {
  return Array.from({ length: count }, (_, i) => (i - (count - 1) / 2) * spacing);
}

/** Module centres along a liner cavity span given in mm — the span is always a
 * whole number of modules (INV-7), so this is exactly `moduleCenters`. */
export function gridCenters(span: number, spacing: number): number[] {
  return moduleCenters(Math.round(span / spacing), spacing);
}

/** The §4 interlock dimensions. `bump` is the proud/deep height `b`
 * (WALL_BUMP on bins, GRID_BUMP on the liner — the same interface value,
 * INV-1). */
export interface InterlockDims {
  /** Male rib width `w` (INV-1). */
  ribWidth: number;
  /** Locating female slot width `w + 2c` — the bin socket (REQ-4.1). */
  socketWidth: number;
  /** Relief female slot width, line-to-line `w` — the liner groove (REQ-4.2). */
  grooveWidth: number;
  /** Backing boss width behind a bin socket: `socket + 2w`. */
  binBossWidth: number;
  /** Backing boss width behind a liner groove: `3w`. */
  linerBossWidth: number;
  /** REQ-4.4: a female slot needs a backing boss only while the wall is
   * thinner than `2b` (the slot would sever it, or leave under `b` behind
   * it); a thicker wall swallows the slot as a plain blind pocket. */
  needBoss: boolean;
}

export function interlockDims(p: ParamValues, bump: number): InterlockDims {
  const rw = p.ribWidth;
  const socketWidth = rw + 2 * (p.clear ?? 0);
  return {
    ribWidth: rw,
    socketWidth,
    grooveWidth: rw,
    binBossWidth: socketWidth + 2 * rw,
    linerBossWidth: 3 * rw,
    needBoss: p.wallThick < 2 * bump,
  };
}
