import { drawRoundedRectangle } from "replicad";
import type { Shape3D, Sketch } from "replicad";
import type { ModelDef, ParamDef, ParamValues } from "./types.ts";
import { boolParam } from "./types.ts";
import { box } from "./bin-common.ts";

/**
 * Port of Hardcase_Gridfinity_Perimeter_Template.f3d — two 1mm (TEST_THICK)
 * "test print" slices through the HARD CASE wall, one across the width and one
 * across the length. Each is a closed-frame cross-section: two tapered walls
 * joined by a rounded floor and a top cap, TEST_OFFSET (10mm) thick — you print
 * them to check the case wall profile / taper / bottom radius before printing
 * bins.
 *
 * Built by slicing a case shell (tapered walls + rounded-fillet floor + top cap)
 * through its CENTRE in each direction — a centre cut hits the two perpendicular
 * walls plus the floor and cap; a cut at a wall would only give a flat panel.
 * The two slices are then moved to opposite edges so they don't overlap.
 *
 * Ground truth: 2 solids, ~6,646 and ~8,646 mm³ (compared in a different
 * coordinate frame, so smoke checks the bounding box only).
 */

const deg = (d: number): number => (d * Math.PI) / 180;

/** Inward pull of the outer wall at height z from the case bottom-corner radius. */
function filletInset(z: number, r: number): number {
  return r > 0 && z < r ? r - Math.sqrt(r * r - (r - z) * (r - z)) : 0;
}

/** Outer case footprint at height z, inset inward by `inset` (0 = outer face). */
function outerAt(z: number, inset: number, p: ParamValues): Sketch {
  const shrinkL = 2 * (p.overallHeight - z) * Math.tan(deg(p.frontWallTaper));
  const shrinkW = 2 * (p.overallHeight - z) * Math.tan(deg(p.sideWallTaper));
  const fillet = 2 * filletInset(z, p.bottomCornerRadius);
  const len = Math.max(p.overallLength - shrinkL - fillet - 2 * inset, 1);
  const wid = Math.max(p.overallWidth - shrinkW - fillet - 2 * inset, 1);
  const rad = Math.max(p.bottomCornerRadius - inset, 0.5);
  return drawRoundedRectangle(len, wid, rad).sketchOnPlane("XY", z) as Sketch;
}

/** Tapered case box (inset from the outer face by `inset`) as a solid: a short
 * fillet loft over the bottom radius fused to a straight body loft above, so the
 * bottom rounds inward without the mixed loft splining the body straight. */
function caseSolid(inset: number, p: ParamValues): Shape3D {
  const r = p.bottomCornerRadius;
  const [base, ...rest] = [0, 0.3, 0.6, 1].map((f) => outerAt(f * r, inset, p));
  const fillet = base.loftWith(rest) as Shape3D;
  const body = outerAt(r, inset, p).loftWith(outerAt(p.overallHeight, inset, p)) as Shape3D;
  return fillet.fuse(body);
}

/** The case shell as the template models it: a closed frame in cross-section —
 * tapered walls with a TEST_OFFSET-thick rounded floor AND a matching top cap
 * (the cross-sections show floor + two walls + a full-width top band). */
function caseShell(p: ParamValues): Shape3D {
  const t = p.testOffset;
  const H = p.overallHeight;
  const outer = caseSolid(0, p);
  // Trim the inner solid to z ∈ [t, H−t] so the bottom `t` (floor) and the top
  // `t` (cap) both stay solid after the cut.
  const inner = caseSolid(t, p).intersect(
    box(p.overallLength + 100, p.overallWidth + 100, t, H - t),
  );
  return outer.cut(inner) as Shape3D;
}

const templateParams: ParamDef[] = [
  { key: "overallLength", fusionName: "OVERALL_LENGTH", label: "Case length", default: 350, unit: "mm", min: 60, max: 900, step: 1 },
  { key: "overallWidth", fusionName: "OVERALL_WIDTH", label: "Case width", default: 250, unit: "mm", min: 60, max: 900, step: 1 },
  { key: "overallHeight", fusionName: "Overall_HT", label: "Case depth", default: 110, unit: "mm", min: 10, max: 400, step: 1 },
  { key: "bottomCornerRadius", fusionName: "BOTTOM_CORNER_RADIUS", label: "Bottom corner radius", default: 19.05, unit: "mm", min: 1, max: 60, step: 0.05 },
  { key: "sideWallTaper", fusionName: "SIDE_WALL_TAPER", label: "Side wall taper", default: 1, unit: "deg", min: 0, max: 15, step: 0.5 },
  { key: "frontWallTaper", fusionName: "FRONT_WALL_TAPER", label: "Front wall taper", default: 1, unit: "deg", min: 0, max: 15, step: 0.5 },
  { key: "testOffset", fusionName: "TEST_OFFSET", label: "Wall thickness", default: 10, unit: "mm", min: 2, max: 30, step: 0.5 },
  { key: "testThick", fusionName: "TEST_THICK", label: "Slice thickness", default: 1, unit: "mm", min: 0.5, max: 5, step: 0.5 },
  { key: "generateLength", type: "boolean", label: "Generate Length Template", default: true },
  { key: "generateWidth", type: "boolean", label: "Generate Width Template", default: true },
];

export const perimeterTemplate: ModelDef = {
  id: "perimeter-template",
  name: "Perimeter template",
  description:
    "Two 1mm cross-section slices of the hard case wall — one across the width, " +
    "one across the length — for test-fitting the wall profile against the case.",
  params: templateParams,
  presets: [
    { label: "Apache 3800", values: { overallLength: 377.825, overallWidth: 268.2875, overallHeight: 110 } },
    { label: "Apache 4800", values: { overallLength: 454.025, overallWidth: 323.85, overallHeight: 125 } },
  ],
  groups: [
    { title: "Basic dimensions", collapsed: false, keys: ["overallLength", "overallWidth", "overallHeight", "testOffset", "testThick"] },
    { title: "Advanced dimensions", collapsed: true, keys: ["bottomCornerRadius", "sideWallTaper", "frontWallTaper"] },
    { title: "Printer convenience", collapsed: false, keys: ["generateLength", "generateWidth"] },
  ],
  build(p: ParamValues): Shape3D[] {
    const shell = caseShell(p);
    const L = p.overallLength;
    const W = p.overallWidth;
    const H = p.overallHeight;
    const tt = p.testThick;
    const genLen = boolParam(p, "generateLength", true);
    const genWid = boolParam(p, "generateWidth", true);

    const pieces: Shape3D[] = [];

    // Width cross-section: a thin slab across the length (centre cut hits the two
    // side walls + floor).
    if (genWid) {
      const widthSlice = box(tt, W + 4, 0, H).intersect(shell) as Shape3D;
      pieces.push(widthSlice.translate(-(L / 2 - tt / 2), 0, 0) as Shape3D);
    }

    // Length cross-section: a thin slab across the width.
    if (genLen) {
      const lengthSlice = box(L + 4, tt, 0, H).intersect(shell) as Shape3D;
      pieces.push(lengthSlice.translate(0, W / 2 - tt / 2, 0) as Shape3D);
    }

    return pieces;
  },
};
