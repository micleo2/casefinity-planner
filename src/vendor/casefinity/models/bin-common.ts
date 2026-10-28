import { draw, drawRectangle } from "replicad";
import type { Shape3D, Sketch } from "replicad";
import type { ParamDef, ParamValues } from "./types.ts";
import {
  draftAngleParam,
  draftedProfile,
  interlockDims,
  moduleCenters,
  ribWidthParam,
} from "./registration.ts";
import type { DraftedFeature } from "./registration.ts";

export { moduleCenters };

/**
 * Shared geometry for the Hardcase Gridfinity bins, reverse-engineered from
 * the ground-truth STEP files by slab probing and boolean diffing (see
 * scripts/diff-model.mjs; the no-lid variant matches to 0.02% by volume).
 *
 * - Outer footprint: modules * GRID_SPACING - 2 * CLEAR, sharp corners
 * - Floor FLOOR_THICK, walls WALL_THICK, open top at OVERALL_HT
 * - Bins interlock side by side: exterior vertical ribs (RIB_WIDTH wide,
 *   WALL_BUMP proud) at module centers on two adjacent faces (-X, +Y); the
 *   opposite walls carry matching sockets — a slot (RIB_WIDTH + 2*CLEAR
 *   wide, WALL_BUMP deep) cut into the wall at each module center. On a thin
 *   wall (WALL_THICK < 2*WALL_BUMP) the slot severs the wall, so it is backed
 *   by an interior boss (slot + 2*RIB_WIDTH wide, WALL_BUMP thick) keeping
 *   the cavity closed; a thick wall swallows the slot as a plain blind pocket
 *   and needs no boss.
 *
 * Registration geometry (rib width, slot width, bump depth) derives from
 * RIB_WIDTH / WALL_BUMP / CLEAR only — WALL_THICK is structural and can vary
 * without changing how bins register (spec INV-2).
 * - One wall (+Y, a ribbed one) extends PULL_TAB_HT above the rim with a
 *   drafted pull slot and two 45-degree gussets (side-wall continuations)
 */

export function box(
  width: number,
  depth: number,
  z0: number,
  z1: number,
  cx = 0,
  cy = 0,
): Shape3D {
  return drawRectangle(width, depth)
    .translate(cx, cy)
    .sketchOnPlane("XY", z0)
    .extrude(z1 - z0) as Shape3D;
}

/** The prism form of `draftedProfile`: a drafted registration feature standing
 * from `z0` to `z1`. Draft is taken about the wall's normal, so the feature is
 * still a straight vertical extrusion — only its cross-section is a trapezoid
 * rather than a rectangle. */
export function draftedBox(f: DraftedFeature, p: ParamValues, z0: number, z1: number): Shape3D {
  return (draftedProfile(f, p.draftAngle ?? 0).sketchOnPlane("XY", z0) as Sketch).extrude(z1 - z0) as Shape3D;
}

/** The +X socket cutter, shared with the with-lid variant's rail ledge (which
 * re-cuts the same slot through material added after the body was built — it
 * has to be the same drafted cutter or the slot steps in width partway up). */
export function binSocketCutterX(p: ParamValues, w: number, c: number): DraftedFeature {
  const { socketWidth } = interlockDims(p, p.wallBump);
  return { axis: "X", from: w / 2 - p.wallBump, to: w / 2, face: w / 2, narrow: -1, width: socketWidth, at: c };
}

/**
 * The nominal grid extent of a module count, for the form's live hint next to
 * the (narrow) module inputs. The printed footprint is 2*CLEAR smaller — that
 * shrink is a print clearance, not part of what a module *means*, so the hint
 * reports the grid pitch the count buys.
 */
const moduleSpan = (key: string) => (p: ParamValues) =>
  `= ${Number((p[key] * p.gridSpacing).toFixed(2))} mm`;

/** Parameters shared by every bin variant. */
export const binParams: ParamDef[] = [
  { key: "widthModules", fusionName: "WIDTH_MODULE_NUMBER", label: "Width (modules)", default: 3, unit: "", min: 1, max: 20, step: 1, hint: moduleSpan("widthModules") },
  { key: "lengthModules", fusionName: "LENGTH_MODULE_NUMBER", label: "Length (modules)", default: 3, unit: "", min: 1, max: 20, step: 1, hint: moduleSpan("lengthModules") },
  { key: "gridSpacing", fusionName: "GRID_SPACING", label: "Grid spacing", default: 15, unit: "mm", min: 10, max: 50, step: 0.5 },
  { key: "overallHeight", fusionName: "OVERALL_HT", label: "Height", default: 110, unit: "mm", min: 20, max: 300, step: 1 },
  { key: "wallThick", fusionName: "WALL_THICK", label: "Wall thickness", default: 1.2, unit: "mm", min: 0.8, max: 3, step: 0.1 },
  ribWidthParam,
  draftAngleParam,
  { key: "floorThick", fusionName: "FLOOR_THICK", label: "Floor thickness", default: 1, unit: "mm", min: 0.6, max: 4, step: 0.2 },
  { key: "clear", fusionName: "CLEAR", label: "Clearance", default: 0.1, unit: "mm", min: 0, max: 0.5, step: 0.05 },
  { key: "wallBump", fusionName: "WALL_BUMP", label: "Rib depth", default: 1.5, unit: "mm", min: 0.5, max: 3, step: 0.1 },
  { key: "pullTabHeight", fusionName: "PULL_TAB_HT", label: "Pull tab height", default: 5, unit: "mm", min: 0, max: 15, step: 0.5 },
  { key: "pullHoleLength", fusionName: "PULL_HOLE_LENGTH", label: "Pull slot length", default: 10, unit: "mm", min: 4, max: 30, step: 1 },
  { key: "lidPullHeight", fusionName: "LID_PULL_HT", label: "Pull slot height", default: 1, unit: "mm", min: 0.5, max: 5, step: 0.5 },
];

export function withDefaults(
  params: ParamDef[],
  overrides: Record<string, number>,
): ParamDef[] {
  return params.map((p) =>
    p.key in overrides ? { ...p, default: overrides[p.key] } : p,
  );
}

/**
 * The side-wall interlock: exterior ribs on the -X and +Y faces (WALL_BUMP
 * proud), matching sockets on the +X and -Y faces (a slot cut WALL_BUMP deep
 * into the wall). A wall thinner than 2*WALL_BUMP is severed by the slot, so
 * the slot is backed by an interior boss keeping the pocket blind; a thicker
 * wall holds the slot with a full WALL_BUMP of material behind it and the
 * boss is omitted (spec REQ-4.4). `bossZ0` is where the interior bosses start
 * (the floor level, so they don't obstruct the cavity floor). Shared by every
 * bin. All widths come from the shared registration interface (registration.ts)
 * and derive from RIB_WIDTH, never WALL_THICK (spec INV-2).
 */
export function addInterlockRibs(
  bin: Shape3D,
  w: number,
  d: number,
  h: number,
  p: ParamValues,
  bossZ0: number,
): Shape3D {
  const t = p.wallThick;
  const bump = p.wallBump;
  const { ribWidth: rw, socketWidth: slotWidth, binBossWidth: bossWidth, needBoss } = interlockDims(p, bump);
  // Ribs and sockets are drafted about the wall's normal (registration.ts):
  // nominal width at the wall face, narrowing as the feature runs away from it.
  // The backing bosses are NOT drafted — REQ-4.4 makes them an internal
  // construction detail that no mating part ever touches.
  for (const c of moduleCenters(p.lengthModules, p.gridSpacing)) {
    bin = bin.fuse(draftedBox(
      { axis: "X", from: -w / 2 - bump, to: -w / 2, face: -w / 2, narrow: -1, width: rw, at: c }, p, 0, h));
  }
  for (const c of moduleCenters(p.widthModules, p.gridSpacing)) {
    bin = bin.fuse(draftedBox(
      { axis: "Y", from: d / 2, to: d / 2 + bump, face: d / 2, narrow: 1, width: rw, at: c }, p, 0, h));
  }
  for (const c of moduleCenters(p.lengthModules, p.gridSpacing)) {
    if (needBoss) bin = bin.fuse(box(bump, bossWidth, bossZ0, h, w / 2 - t - bump / 2, c));
    bin = bin.cut(draftedBox(binSocketCutterX(p, w, c), p, 0, h));
  }
  for (const c of moduleCenters(p.widthModules, p.gridSpacing)) {
    if (needBoss) bin = bin.fuse(box(bossWidth, bump, bossZ0, h, c, -d / 2 + t + bump / 2));
    bin = bin.cut(draftedBox(
      { axis: "Y", from: -d / 2, to: -d / 2 + bump, face: -d / 2, narrow: 1, width: slotWidth, at: c }, p, 0, h));
  }
  return bin;
}

/**
 * The pull tab: the +Y wall continues PULL_TAB_HT above the rim with two 45°
 * side gussets and a drafted finger slot. Shared by the bin variants.
 */
export function addPullTab(bin: Shape3D, w: number, d: number, h: number, p: ParamValues): Shape3D {
  const t = p.wallThick;
  bin = bin.fuse(box(w, t, h, h + p.pullTabHeight, 0, d / 2 - t / 2));
  const yInner = d / 2 - t;
  // The gusset's reach into the bin (in Y) grows with wallThick (narrower
  // yInner) and with pullTabHeight (steeper/longer 45° diagonal). Both faces
  // it sits on (+X, -X) carry the outermost rib/socket at the same Y (both use
  // lengthModules centres — REQ-3.4 centring). Left unclamped, a big enough
  // wallThick or pullTabHeight lets the gusset reach past that feature and
  // fuse in directly above its footprint: harmless over a proud rib, but over
  // a socket it caps the open slot from above with unrelated print geometry —
  // an overhang requiring bridging/support material inside a female pocket
  // nobody can clean out (an occluded registration feature). Clamp the reach,
  // not PULL_TAB_HT itself: the wall extension still rises the full height,
  // only the diagonal gets steeper once it nears the corner feature. At the
  // parameter defaults the natural margin already clears this floor, so the
  // clamp is inactive there (same pattern as addDividers' outerMag clamp).
  const cornerCenters = moduleCenters(p.lengthModules, p.gridSpacing);
  const outerCenter = Math.max(...cornerCenters);
  const { socketWidth } = interlockDims(p, p.wallBump);
  const dangerMargin = 0.5;
  const maxReach = yInner - (outerCenter + socketWidth / 2 + dangerMargin);
  const reach = Math.max(0.5, Math.min(p.pullTabHeight, maxReach));
  const gusset = draw([yInner, h])
    .lineTo([yInner - reach, h])
    .lineTo([yInner, h + p.pullTabHeight])
    .close();
  for (const x0 of [w / 2 - t, -w / 2]) {
    bin = bin.fuse((gusset.sketchOnPlane("YZ", x0) as Sketch).extrude(t) as Shape3D);
  }
  // pull slot through the tab: a drafted cut, wider at the inner face
  // (measured 1.86 mm outer / 2.6 mm inner around a LID_PULL_HT core)
  const zc = h + p.pullTabHeight / 2;
  const hOut = (p.lidPullHeight + 0.86) / 2;
  const hIn = (p.lidPullHeight + 1.6) / 2;
  const yOut = d / 2;
  const slot = draw([yOut + 1, zc - hOut])
    .lineTo([yOut, zc - hOut])
    .lineTo([yInner, zc - hIn])
    .lineTo([yInner - 1, zc - hIn])
    .lineTo([yInner - 1, zc + hIn])
    .lineTo([yInner, zc + hIn])
    .lineTo([yOut, zc + hOut])
    .lineTo([yOut + 1, zc + hOut])
    .close();
  return bin.cut(
    (slot.sketchOnPlane("YZ", -p.pullHoleLength / 2) as Sketch).extrude(p.pullHoleLength) as Shape3D,
  );
}

/**
 * Build the shared bin body. When `solid` is true the interior cavity is not
 * cut, yielding a completely filled block (same footprint, interlock ribs and
 * pull tab) — the basis of the Solid Block model, meant for subtracting custom
 * pockets in CAD. The interior bosses that back the sockets are redundant on a
 * solid block but harmless, so the same `addInterlockRibs` path is reused.
 */
export function buildBinBody(p: ParamValues, solid = false): Shape3D {
  const w = p.widthModules * p.gridSpacing - 2 * p.clear;
  const d = p.lengthModules * p.gridSpacing - 2 * p.clear;
  const h = p.overallHeight;
  const t = p.wallThick;

  let bin = box(w, d, 0, h);
  if (!solid) bin = bin.cut(box(w - 2 * t, d - 2 * t, p.floorThick, h + 1));
  bin = addInterlockRibs(bin, w, d, h, p, solid ? 0 : p.floorThick);
  if (p.pullTabHeight > 0) bin = addPullTab(bin, w, d, h, p);
  return bin;
}
