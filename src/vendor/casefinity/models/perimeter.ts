import { drawRoundedRectangle, drawRectangle, draw } from "replicad";
import type { Shape3D, Sketch, Drawing } from "replicad";
import type { ModelDef, ParamDef, ParamValues } from "./types.ts";
import { boolParam } from "./types.ts";
import { draftAngleParam, draftedProfile, gridCenters, interlockDims, ribWidthParam } from "./registration.ts";

/**
 * Port of Hardcase_Gridfinity_Perimeter.f3d — the liner frame that drops into
 * a hard case and registers the bins to a grid.
 *
 * Reverse-engineered from ground-truth/Hardcase_Gridfinity_Perimeter.step
 * (see scripts/diff-aligned.mjs). The border is a thin-walled U-channel open
 * at the top:
 *   - inner (cavity) wall: vertical, WALL_THICK thick, at the cavity boundary;
 *   - outer (case) wall: tapered by the front/side wall draft, meeting the
 *     outer footprint (OVERALL_LENGTH x OVERALL_WIDTH) at the top mouth;
 *   - hollow between the two walls, closed at the bottom by a floor.
 * The cavity opening is OVERALL_* minus the recovered side/front borders
 * (SIDE_BOARDER = L - GRID_SPACING*(floor(L/GRID)-SIDE_BOARDER_BIN_ADD), etc.).
 *
 * Ported (Stages 1-5): the U-channel border walls + floor; the grid-bump
 * features on the inner wall (ribs on the -Y/+X walls, matching grooves on the
 * +Y/-X walls, GRID_BUMP proud/deep, full height, one per grid-cell centre —
 * the bins register against these); the dovetailed split into four border pieces
 * (see splitPieces); configurable divider cross-ribs on the long sides (see
 * addDividers); and the case bottom-corner radius rolled into the outer wall
 * (see outerLoft / filletInset) so the pieces seat cleanly in the case.
 * FLOOR_THICK isn't only the flat floor cap's own height — it also ramps the
 * outer wall's thickness up near the base of that same bottom fillet, so the
 * whole ≤30°-from-horizontal region (a shallow, support-needing overhang, and
 * exactly where a printed piece flexes most) is as thick as the floor rather
 * than dropping straight to WALL_THICK (see floorCollar).
 *
 * Remaining simplification: the foot is a flat floor rather than the real gusset
 * ramp, but the fit-critical outer surface (taper + bottom fillet) matches.
 *
 * The split seams are joined over the FULL height of the frame (see splitPieces).
 * Each seam is closed by a bulkhead filling the U-channel cross-section, and the
 * dovetail runs through it as a vertical prism — a `wallThick` fold on one piece, matching
 * slot on the other. So the pieces assemble by sliding together vertically, and
 * the joint constrains both in-plane axes from the floor to the rim. Vertical
 * separation is deliberately unconstrained: that IS the assembly direction, and
 * the case holds the frame down.
 *
 * This is what the ground truth does and what an earlier port did not. Building
 * the tang by fusing its footprint into a piece's 2-D region and intersecting the
 * frame only materialises it where the hollow U-channel happens to have material
 * in the tang band — which is almost nowhere. Measured at the shipped defaults,
 * the corner tang band sits at y 103..119, but at z=0 the outer footprint reaches
 * only y=102.1 (BOTTOM_CORNER_RADIUS pulls the wall in over the whole bottom
 * fillet), so below z≈19 the band was outside the frame entirely and above it was
 * a sliver of channel. That near-absent joint is why the model briefly carried
 * optional screw bosses at the seams; a full-height dovetail removes the reason
 * for them (see docs/superpowers/specs/2026-08-07-full-height-dovetails-design.md).
 *
 * Print clearances (both default to a nominal fit; dial in per printer/material):
 *   - `clearance` (CLEARANCE) shrinks the whole outer envelope so the assembled
 *     frame drops into the case (default 0 = exact case size);
 *   - `dovetailClear` (BOARDER_DOVETAIL_CLEAR) opens a gap between each tang and
 *     its socket so the four pieces slide together (default 0.2 mm).
 */

const deg = (d: number) => (d * Math.PI) / 180;

/** Outer-wall rounded rectangle at height z, inset inward by `inset`. */
function outerAt(z: number, inset: number, p: ParamValues): Sketch {
  // Walls taper inward toward the bottom; z = overallHeight is the case mouth.
  const shrinkL = 2 * (p.overallHeight - z) * Math.tan(deg(p.frontWallTaper));
  const shrinkW = 2 * (p.overallHeight - z) * Math.tan(deg(p.sideWallTaper));
  // The wall rolls inward over the last BOTTOM_CORNER_RADIUS to follow the case's
  // rounded bottom (a quarter-round tangent to the wall at z = radius); so the
  // footprint is pulled in by 2*filletInset near the base.
  const fillet = 2 * filletInset(z, p);
  // CLEARANCE shrinks the whole outer envelope so the assembled frame drops into
  // the case with a small gap (both wall faces move in equally, thickness kept).
  const clear = 2 * p.clearance;
  const length = p.overallLength - shrinkL - fillet - clear - 2 * inset;
  const width = p.overallWidth - shrinkW - fillet - clear - 2 * inset;
  const radius = Math.max(p.bottomCornerRadius - inset, 0.5);
  return drawRoundedRectangle(length, width, radius).sketchOnPlane("XY", z) as Sketch;
}

/** How far the outer wall is drawn inward at height z by the case bottom-corner
 * radius (a quarter-round tangent to the wall at z = radius, meeting the floor
 * at z = 0). Zero above the radius. */
function filletInset(z: number, p: ParamValues): number {
  const r = p.bottomCornerRadius;
  if (r <= 0 || z >= r) return 0;
  return r - Math.sqrt(r * r - (r - z) * (r - z));
}

/** The outer wall solid: a short multi-section loft over the bottom fillet
 * (z = 0..radius) fused to a straight two-section loft for the tapered body
 * (z = radius..height). Splitting them keeps the fillet's clustered sections
 * from corrupting the straight taper (a single mixed loft splines the body out
 * to full width). */
function outerLoft(inset: number, p: ParamValues): Shape3D {
  const r = p.bottomCornerRadius;
  const [base, ...rest] = [0, 0.3, 0.6, 1].map((f) => outerAt(f * r, inset, p));
  const fillet = base.loftWith(rest) as Shape3D;
  const body = outerAt(r, inset, p).loftWith(outerAt(p.overallHeight, inset, p)) as Shape3D;
  return fillet.fuse(body);
}

/**
 * Extra wall material ramping from FLOOR_THICK at z=0 down to WALL_THICK at
 * z=0.3*bottomCornerRadius (the fillet loft's own next sample). The fillet is
 * a quarter-round of radius r=bottomCornerRadius, so its tangent is θ from
 * horizontal at height r(1−cos θ) — the tangent reaches 30° from horizontal
 * at just r(1−cos30°) ≈ 0.134*r, well inside this ramp's 0..0.3*r span, so
 * the whole ≤30°-from-horizontal zone sits within it. A 30°-from-horizontal
 * overhang is a shallow one in FDM terms (it needs support if left thin) and
 * is exactly where a printed piece flexes most, so thickening it toward the
 * floor's own thickness makes that band self-supporting and stiffens the
 * piece. The ramp must reach ABOVE the flat floor cap's own height (built
 * separately in buildPerimeter, z=0..FLOOR_THICK) or the extra material is
 * entirely masked by it: at typical defaults FLOOR_THICK alone already
 * reaches past the 30° point, so a collar that stopped there would add next
 * to nothing — reaching to 0.3*r instead extends real, unmasked thickness
 * above the floor cap, right where the wall would otherwise drop straight
 * back to WALL_THICK.
 *
 * `wallInner` MUST be the actual `outerLoft(t, p)` already built for the wall
 * cut in buildPerimeter (not re-derived here): the fillet is a circular arc,
 * a nonlinear function of z, and a fresh 2-point loft at inset=t can't
 * reproduce that curve — it comes out MORE pulled-in than the real wall at
 * every intermediate height, so a from-scratch "outer" edge sits entirely
 * inside the real wall's own solid and contributes exactly zero volume when
 * fused (measured — an earlier version did this and the frame's total volume
 * didn't move at all). Restricting the real wallInner to z<=zEnd guarantees
 * the collar's outer face is pixel-for-pixel the same surface as the wall's.
 *
 * The ramp itself is a single, monotonic two-point loft — inset=FLOOR_THICK
 * at z=0 straight to inset=WALL_THICK at zEnd, no intermediate "hold flat
 * then bend" sample. Two earlier attempts added a middle sample (at the 30°
 * height) to keep the near-horizontal zone uniformly thick before ramping:
 * one mixed it into outerLoft's own 5-section spline and it overshot enough
 * to measure LESS total material than before; the other kept it as its own
 * short 3-section loft and *that* overshot too, past the real wall's surface,
 * erasing nearly the whole collar (measured: 350 mm³ instead of the ~2900 mm³
 * a sane ramp gives). A flat-plateau-then-bend profile is exactly the shape
 * that makes a spline loft overshoot regardless of how few points it's split
 * across; a plain monotonic 2-point ramp has no such inflection to overshoot.
 *
 * `outerInnerY` (used by addDividers to trace a rib's outer edge) still
 * assumes a flat WALL_THICK inset; that's conservative here, not wrong — it
 * places the divider's outer edge further out than this collar's actual inner
 * face, so the rib fuse only picks up extra (harmless) overlap, never a gap.
 */
function floorCollar(p: ParamValues, wallInner: Shape3D): Shape3D | null {
  const t = p.wallThick;
  if (p.footThick <= t) return null; // FLOOR_THICK no thicker than the wall — nothing to add
  const r = p.bottomCornerRadius;
  const zEnd = 0.3 * r; // > filletAngleZ(30, p) ≈ 0.134*r always; matches outerLoft's own sample
  // Cutter sized to the case, not an arbitrary huge box — cheaper for OCCT,
  // and this runs on every build (unlike splitPieces' own `big`, computed once
  // per split), so the small WASM heap on heavy bed-split configurations feels
  // the difference (measured: an oversized cutter here was enough to tip the
  // heaviest bed-fit variant over the limit).
  const big = Math.max(p.overallLength, p.overallWidth);
  const cutter = (drawRectangle(big, big).sketchOnPlane("XY", 0) as Sketch).extrude(zEnd) as Shape3D;
  const outerShell = wallInner.clone().intersect(cutter);
  const innerShell = (outerAt(0, p.footThick, p) as Sketch).loftWith(outerAt(zEnd, t, p)) as Shape3D;
  return outerShell.cut(innerShell) as Shape3D;
}

/** Cavity opening dimensions: OVERALL_* minus the recovered side/front border
 * (SIDE_BOARDER = L - GRID_SPACING*(floor(L/GRID) - SIDE_BOARDER_BIN_ADD)). */
function cavityDims(p: ParamValues): { length: number; width: number } {
  const sideBoarder =
    p.overallLength - p.gridSpacing * (Math.floor(p.overallLength / p.gridSpacing) - p.sideBoarderBinAdd);
  const frontBoarder =
    p.overallWidth - p.gridSpacing * (Math.floor(p.overallWidth / p.gridSpacing) - p.frontBoarderBinAdd);
  return { length: p.overallLength - sideBoarder, width: p.overallWidth - frontBoarder };
}

/** Cavity-boundary rounded rectangle, expanded outward (into the border) by
 * `outset`. outset 0 is the cavity hole itself. */
function cavityAt(z: number, outset: number, p: ParamValues): Sketch {
  const { length, width } = cavityDims(p);
  const radius = Math.max(p.wallCornerRadius + outset, 0.5);
  return drawRoundedRectangle(length + 2 * outset, width + 2 * outset, radius).sketchOnPlane("XY", z) as Sketch;
}

/**
 * Grid-bump features on the inner (cavity) wall, one per grid-cell centre,
 * full height. Like the bins, adjacent walls differ: the -Y and +X walls carry
 * ribs proud into the cavity (GRID_BUMP proud, RIB_WIDTH wide), while the
 * opposite +Y and -X walls carry matching grooves cut into the wall — so a bin,
 * whose exterior has ribs on two faces and sockets on the two others, registers
 * either way round. Registration widths derive from RIB_WIDTH / GRID_BUMP only;
 * WALL_THICK is structural (it sets how deep a rib anchors into the wall and
 * whether a groove needs a backing boss) and never changes the interface
 * dimensions (spec INV-2).
 *
 * Applied per wall so the split can add each wall's features to the one piece
 * that owns that wall (a +X-wall rib fused to a whole frame that is later split
 * would orphan into the neighbouring side piece). `walls` selects which of the
 * four to apply. Ribs are fused, grooves cut; each set is unioned as one 2-D
 * drawing and applied in a single boolean (cheap).
 */
type WallSpec = { axis: "X" | "Y"; sign: 1 | -1; kind: "rib" | "groove" };
const ALL_WALLS: WallSpec[] = [
  { axis: "Y", sign: -1, kind: "rib" }, // -Y wall
  { axis: "X", sign: 1, kind: "rib" }, // +X wall
  { axis: "Y", sign: 1, kind: "groove" }, // +Y wall
  { axis: "X", sign: -1, kind: "groove" }, // -X wall
];

function applyGridFeatures(shape: Shape3D, p: ParamValues, walls: WallSpec[] = ALL_WALLS): Shape3D {
  const { length, width } = cavityDims(p);
  const half = { X: length / 2, Y: width / 2 };
  const t = p.wallThick;
  const b = p.gridBump;
  // Registration widths come from the shared interface (registration.ts);
  // depths are structural: ribs span GRID_BUMP proud of the cavity face plus
  // WALL_THICK back into the wall (the embed is anchoring; the proud, mating
  // part is always exactly GRID_BUMP), grooves cut from 0.3 mm inside the face
  // to GRID_BUMP deep. Both are DRAFTED about the wall's normal — nominal width
  // at the cavity face, narrowing as the feature runs away from it (see
  // draftedProfile) — so a rib thins toward its tip and a groove flares at its
  // mouth. Nothing about the depths changes, hence nothing about the cavity's
  // extents.
  const { ribWidth: rw, grooveWidth, linerBossWidth: bossWide, needBoss } = interlockDims(p, b);
  const rect = (cx: number, cy: number, wx: number, wy: number) =>
    drawRectangle(wx, wy).translate(cx, cy);
  type Draw = ReturnType<typeof rect>;
  const solid = (rects: Draw[]) =>
    rects.reduce((a, r) => (a ? a.fuse(r) : r)).sketchOnPlane("XY", 0).extrude(p.overallHeight) as Shape3D;

  // On a thin wall (needBoss: t < 2b, spec REQ-4.4) the `b`-deep slot cuts
  // clean through and would read as an open slit into the U-channel hollow.
  // Back it with a wider boss (like the bin socket's interior boss) so the
  // female pocket is blind and the cavity stays closed — the bin rib seats
  // against it. A wall at least 2b thick holds the slot with ≥ b of material
  // behind it, so the groove is cut straight into the flat wall, boss omitted.
  const bossDepth = t + b; // spans the wall plus GRID_BUMP into the hollow

  let out = shape;
  for (const w of walls) {
    // Feature only the flat wall sections. A grid centre inside a rounded corner
    // arc (|c| > span/2 − wallCornerRadius) would place a rib/groove on the curve,
    // where no bin face registers; the ground truth leaves the corners clean.
    const span = w.axis === "X" ? width : length;
    const centers = gridCenters(span, p.gridSpacing).filter(
      (c) => Math.abs(c) <= span / 2 - p.wallCornerRadius,
    );
    // A block at each grid centre: `mag` = its centre's distance from the cavity
    // centre, `wide` = size along the wall, `deep` = size normal to the wall.
    const feat = (mag: number, wide: number, deep: number): Shape3D => {
      const rects = centers.map((c) =>
        w.axis === "X"
          ? rect(w.sign * mag, c, deep, wide) // ±X wall: normal along X, along-wall in Y
          : rect(c, w.sign * mag, wide, deep), // ±Y wall: along-wall in X, normal along Y
      );
      return solid(rects);
    };
    // The drafted form of `feat`, given the feature's extent as a mag range and
    // the width it holds at the cavity face. `mag` grows away from the cavity
    // centre and the signed coordinate is `sign * mag`, so "narrows with
    // increasing mag" (a groove, going into the wall) is `narrow = sign` and
    // "narrows with decreasing mag" (a rib, going into the cavity) is its
    // negation.
    const draftedFeat = (magFrom: number, magTo: number, wide: number, intoWall: boolean): Shape3D =>
      solid(centers.map((c) => draftedProfile({
        axis: w.axis,
        from: w.sign * magFrom,
        to: w.sign * magTo,
        face: w.sign * half[w.axis],
        narrow: (intoWall ? w.sign : -w.sign) as 1 | -1,
        width: wide,
        at: c,
      }, p.draftAngle ?? 0)));
    if (w.kind === "rib") {
      out = out.fuse(draftedFeat(half[w.axis] - b, half[w.axis] + t, rw, false));
    } else {
      // The boss is not drafted: REQ-4.4 makes it an internal construction
      // detail, never touched by a mating part.
      if (needBoss) out = out.fuse(feat(half[w.axis] + bossDepth / 2, bossWide, bossDepth)); // backing boss
      out = out.cut(draftedFeat(half[w.axis] - 0.3, half[w.axis] + b, grooveWidth, true)); // the slot
    }
  }
  return out;
}

/** `dividers` evenly-spaced grid-cell centres along the cavity length. */
function dividerCenters(p: ParamValues): number[] {
  const g = gridCenters(cavityDims(p).length, p.gridSpacing);
  const n = Math.min(Math.round(p.dividers), g.length);
  if (n <= 0) return [];
  return Array.from({ length: n }, (_, i) => g[Math.round(((g.length - 1) * (i + 1)) / (n + 1))]);
}

/** Y of the outer wall's inner face at height z on a long side's straight edge
 * (follows the side taper and the bottom fillet). */
function outerInnerY(z: number, p: ParamValues): number {
  const shrinkW = 2 * (p.overallHeight - z) * Math.tan(deg(p.sideWallTaper));
  return (p.overallWidth - shrinkW - 2 * filletInset(z, p)) / 2 - p.wallThick;
}

/**
 * Fuse divider ribs onto one long-side wall (signY = +1 / -1). Each is a full-
 * height cross-rib, RIB_WIDTH wide (a module-boundary feature — it protrudes
 * into the cavity like a grid rib, so its width must not follow WALL_THICK or
 * a thick wall would eat into the adjacent modules), that fills the U-channel
 * from the cavity-face bump across to the case wall — like the BOARDER_DIVIDERS
 * ribs in the source (there placed ad hoc; here at `dividers` evenly-spaced
 * grid centres).
 *
 * The rib's outer edge is drawn as a Y-Z profile that follows the wall taper and
 * bottom fillet, so it meets the case wall at every height without an expensive
 * intersect against the outer loft. Applied BEFORE the grid features (see the
 * callers), not after: a divider coincides in X with a grid module centre by
 * construction, and on the +Y/-X (groove) walls, cutting the groove after the
 * divider's fuse is what keeps the groove open — see applyGridFeatures's
 * caller-ordering note.
 */
function addDividers(shape: Shape3D, p: ParamValues, signY: 1 | -1): Shape3D {
  const centers = dividerCenters(p);
  if (!centers.length) return shape;
  const h = p.overallHeight;
  // The divider's cavity-facing edge must sit flush with whatever that wall
  // actually presents at the cavity boundary — NOT the same offset on both
  // walls. The -Y wall carries a rib (ALL_WALLS convention): its per-module
  // rib already reaches GRID_BUMP past the face, so flushing the divider to
  // the rib tip avoids a visible step. The +Y wall carries a groove (a
  // recess, not a protrusion): there is no bump to flush against, so the
  // divider must stop AT the face. Using the rib-tip offset on the groove
  // wall too made the divider poke GRID_BUMP into the open cavity as a
  // phantom nub — and once the groove cut (correctly) runs last, that nub
  // gets sliced clean off the frame as floating debris (a piece the split
  // count and one-clean-solid checks below both catch).
  const isRibWall = signY < 0;
  const innerMag = isRibWall ? cavityDims(p).width / 2 - p.gridBump : cavityDims(p).width / 2;
  const inner = signY * innerMag;
  const zs = [0, 0.3, 0.6, 1].map((f) => f * p.bottomCornerRadius).concat(h);
  // Profile in the Y-Z plane: inner edge straight at `inner`, outer edge tracing
  // the wall from the base fillet up to the mouth. Near the filleted base the
  // tapered wall can curve inward PAST the bump line (outerInnerY < innerMag) —
  // for a narrow case that inverts the profile into a self-intersecting polygon
  // and the rib fuse degenerates (zero-volume flake, or the whole piece blows up
  // to empty). Clamp the outer edge to stay at least `minGap` outside the inner
  // edge so the profile is always a valid simple polygon; the clamp is inactive
  // wherever the channel is genuinely open, so it never alters a good case.
  const minGap = 0.5;
  const outerMag = (z: number) => Math.max(outerInnerY(z, p), innerMag + minGap);
  let prof = draw([inner, 0]);
  for (const z of zs) prof = prof.lineTo([signY * outerMag(z), z]);
  prof = prof.lineTo([inner, h]);
  const profile = prof.close();
  const ribs = centers
    .map(
      (cx) =>
        (profile.sketchOnPlane("YZ", cx - p.ribWidth / 2) as Sketch).extrude(
          p.ribWidth,
        ) as Shape3D,
    )
    .reduce((a, b) => a.fuse(b));
  return shape.fuse(ribs);
}

/**
 * One split seam: where the two pieces meet, which way the tang points, and
 * which border the joint sits in.
 */
type Seam = {
  /** The axis the tang protrudes along — and the axis the joint locks. */
  axis: "X" | "Y";
  /** Seam-plane coordinate on `axis`. */
  pos: number;
  /** Dovetail band centre on the OTHER axis (the border centre). */
  band: number;
  /** Protrusion direction of the tang along `axis`. */
  dir: 1 | -1;
  /** Which half of the off-axis this seam's border lies in. */
  side: 1 | -1;
  /** Where that half starts, measured from the centre (unsigned). */
  from: number;
};

/**
 * The open U-channel as a solid: everything inside the outer wall's inner face
 * and outside the inner wall's outer face, full height. Intersecting a flat 2-D
 * footprint with this is what gives a seam bulkhead the wall taper, the bottom
 * fillet and CLEARANCE for free — none of the footprint maths has to know the
 * wall profile.
 *
 * `wallInner` is the `outerLoft(wallThick, p)` buildPerimeter already built for
 * the wall cut, passed in rather than rebuilt: it is the single most expensive
 * solid in the model and a second one would double that cost for nothing.
 */
function channelSolid(p: ParamValues, wallInner: Shape3D, footprint: Drawing): Shape3D {
  const prism = (footprint.sketchOnPlane("XY", 0) as Sketch).extrude(p.overallHeight) as Shape3D;
  // Cut the cavity out of the flat prism first, then meet the loft: both
  // operands of the cut are plain extrusions, so it is the cheap half, and it
  // shrinks what reaches the expensive spline-faced loft. Measured a wash
  // against the other order at the defaults (~0.2 s on a ~59 s build, i.e.
  // noise) — kept for the smaller operand, not for a demonstrated speedup.
  return prism
    .cut((cavityAt(0, p.wallThick, p) as Sketch).extrude(p.overallHeight) as Shape3D)
    .intersect(wallInner.clone()) as Shape3D;
}

/**
 * Split the one-piece frame into dovetailed border pieces so it prints in
 * bed-sized parts. The base split is 2 long side-rails + 2 short end caps, cut
 * at the cavity-length boundary (X = ±cavityHalfLength); each long rail carries
 * a dovetail tang at the border centre of its ends (BOARDER_DOVETAIL_WIDTH wide,
 * _DEPTH deep, flaring by _ANGLE so it locks) that plugs into a socket in the
 * end cap. The end caps keep the rounded corners. The socket cut is grown by
 * BOARDER_DOVETAIL_CLEAR beyond the tang, leaving a print-clearance gap.
 *
 * When a printer bed is given (bedWidth/bedDepth > 0), each rail is further
 * subdivided into in-line segments so no piece exceeds the usable bed area
 * (bed minus 2*bedMargin), with an extra dovetail seam at every cut. Blank bed
 * fields (0) mean "no limit" → the original four pieces (Nlong = Nend = 1), so
 * this is a strict generalization of the 4-piece split. Pieces stay in their
 * assembled positions; the viewer and 3MF export present them separately.
 *
 * Every seam — corner joints and bed splits alike — is first given a full-height
 * bulkhead (see the "Full-height joint" block below); the per-piece region
 * algebra then divides it into tang and socket with no extra splitting logic.
 */
function splitPieces(frame: Shape3D, p: ParamValues, wallInner: Shape3D): Shape3D[] {
  const { length, width } = cavityDims(p);
  const splitX = length / 2;
  const yc = (width / 2 + p.overallWidth / 2) / 2; // long-rail border centre (Y)
  const xcEnd = (length / 2 + p.overallLength / 2) / 2; // end-cap border centre (X)
  const w = p.dovetailWidth;
  const depth = p.dovetailDepth;
  const tanA = Math.tan(deg(p.dovetailAngle));
  const secA = 1 / Math.cos(deg(p.dovetailAngle));
  const c = p.dovetailClear; // socket offset by this; tang stays nominal
  const wb = p.wallThick; // the bulkhead's thickness, and the fold's own wall thickness (seamCore's erosion amount)
  const OVERLAP = 2; // how far a profile's base sits inside its owning piece
  const big = Math.max(p.overallLength, p.overallWidth); // generous half-plane bound

  /** Seam-local (along-axis, across-axis) to model (x, y). */
  const pt = (axis: "X" | "Y", a: number, b: number): [number, number] =>
    axis === "X" ? [a, b] : [b, a];

  // Dovetail profile crossing a seam. `axis` is the direction the tang
  // protrudes (and along which the joint locks): "X" for a seam cutting a long
  // rail, "Y" for one cutting an end cap. `pos` is the seam coordinate on that
  // axis, `band` the centre coordinate on the other axis, `dir` = +/-1 the
  // protrusion direction.
  //
  // A hexagon, not a trapezoid: behind the seam plane it is a constant-width
  // rectangle, and only past the seam does the flank rise at tan(angle). That
  // is what makes `dovetailAngle` the true flank angle and `dovetailWidth` the
  // true width at the seam plane. An earlier trapezoid ran the flare across
  // the base overlap as well, flattening the flank to 22.4 deg at the
  // defaults. The base sits OVERLAP inside the owning piece so the fuse
  // overlaps with no coincident-face sliver; the flared tip is what locks.
  //
  // `d` is a SIGNED PERPENDICULAR offset, which is what makes `dovetailClear`
  // a real normal gap: offsetting a flank by `d` moves it `d * secA` across the
  // band, while the tip face moves `d` along the axis. The base face does not
  // move -- it lives inside the owning piece and exists only to avoid that
  // sliver.
  const seamProfile = (axis: "X" | "Y", pos: number, band: number, dir: 1 | -1, d = 0): Drawing => {
    const hwBase = w / 2 + d * secA;
    const reach = depth + d;
    const hwTip = hwBase + reach * tanA;
    const a0 = pos - dir * OVERLAP;
    const a1 = pos + dir * reach;
    const q = (a: number, b: number) => pt(axis, a, b);
    return draw(q(a0, band - hwBase))
      .lineTo(q(a0, band + hwBase))
      .lineTo(q(pos, band + hwBase))
      .lineTo(q(a1, band + hwTip))
      .lineTo(q(a1, band - hwTip))
      .lineTo(q(pos, band - hwBase))
      .close();
  };

  // The tang's void: the very same profile, offset inward by one wall thickness.
  // Cutting it from the seam bulkheads is what turns a solid dovetail prism into
  // a fold, and taking it from `seamProfile` rather than building a second shape
  // is what makes "one wall thick everywhere" structural instead of arithmetical.
  //
  // The void runs the profile's WHOLE length, base overlap included, so it opens
  // into the channel behind the seam. The tang is therefore a folded sheet --
  // two flanks and a tip face, closed at the bottom by the fillet-narrowed
  // channel and open at the back -- not a closed box with the end web as its
  // lid. That is what the ground truth does: at mid-height its rail's end web
  // carries a slot on the dovetail centreline (~1.5 mm at the web, widening to
  // 5.5 mm one millimetre out) rather than bridging across. A fold that sealed
  // itself off at the narrow end would be a drawn pocket, not a fold.
  //
  // Returns null once the erosion eats the profile: past that thickness there
  // is no void to remove and the tang is simply solid -- no caller branch, no
  // new parameter. Both degeneracies are checked: the flanks meeting in the
  // middle, and the tip face reaching back past the seam plane.
  const seamCore = (axis: "X" | "Y", pos: number, band: number, dir: 1 | -1): Drawing | null =>
    w / 2 - wb * secA < 0.05 || depth - wb < 0.05
      ? null
      : seamProfile(axis, pos, band, dir, -wb);
  const rect = (x0: number, x1: number, y0: number, y1: number): Drawing =>
    drawRectangle(x1 - x0, y1 - y0).translate((x0 + x1) / 2, (y0 + y1) / 2);
  const solid = (d: Drawing): Shape3D =>
    (d.sketchOnPlane("XY", 0) as Sketch).extrude(p.overallHeight) as Shape3D;

  // Grid features go on the piece that owns each wall (avoids orphaning a rib
  // into a neighbour); dividers go on the long sides.
  const wallSpec = (axis: "X" | "Y", sign: 1 | -1, kind: "rib" | "groove"): WallSpec[] =>
    p.gridBump > 0 ? [{ axis, sign, kind }] : [];
  const div = (piece: Shape3D, signY: 1 | -1): Shape3D =>
    p.dividers > 0 ? addDividers(piece, p, signY) : piece;

  // Bed-fit segment counts. A thin rail lies along the bed's longer axis, so the
  // length limit is the larger usable dimension. `cornerReserve`/`interiorReserve`
  // hold back room for the tangs a segment protrudes: long rails keep their
  // corner tangs at every N (2*depth), end caps gain one interior tang when N>1.
  // 0 on either bed dimension = no limit → N=1 (the original 4-piece split).
  const bedActive = p.bedWidth > 0 && p.bedDepth > 0;
  const usable = Math.max(p.bedWidth - 2 * p.bedMargin, p.bedDepth - 2 * p.bedMargin);
  const MAXSEG = 24;
  const fitCount = (span: number, cornerReserve: number, interiorReserve: number): number => {
    if (!bedActive) return 1;
    for (let n = 1; n < MAXSEG; n++) {
      if (span / n + (n === 1 ? cornerReserve : interiorReserve) <= usable) return n;
    }
    return MAXSEG;
  };
  const nLong = fitCount(2 * splitX, 2 * depth, 2 * depth);
  const nEnd = fitCount(p.overallWidth, 0, depth);
  const cutsLong = Array.from({ length: nLong - 1 }, (_, i) => -splitX + ((i + 1) * 2 * splitX) / nLong);
  const cutsEnd = Array.from({ length: nEnd - 1 }, (_, i) => -p.overallWidth / 2 + ((i + 1) * p.overallWidth) / nEnd);

  /**
   * Full-height joint. Every seam is closed by a bulkhead filling the U-channel
   * cross-section, `wallThick` thick either side of the seam plane, with the
   * dovetail running through it as a vertical prism. Fused into the frame BEFORE
   * any per-piece region intersect, so the existing region algebra divides it:
   *
   *   tang piece   region = halfplane u tangFootprint
   *                -> end web, slit on the dovetail centreline, with the tang
   *                   folded out of the slit to wallThick
   *   socket piece region = halfplane - grownTang
   *                -> end web pierced by the dovetail mouth, plus flanks and a
   *                   back for the slot
   *
   * BOTH webs are pierced, then, and symmetrically: the tang's fold opens back
   * through its own web into the channel (seamCore runs the profile's whole
   * length), and the socket's mouth opens forward through its web into the slot.
   * The seam is still closed — by the folded box the tang forms rather than by a
   * flat plate across it.
   *
   * Two flat 2-D pieces per seam are enough, because channelSolid trims them to
   * the wall profile:
   *   - `web`, spanning +/-wallThick about the seam plane and the whole half of
   *     the off-axis that this border lies in. A HALF-PLANE, not the nominal
   *     border width: at the corner seams (x = +/-splitX) the cavity's rounded
   *     corner has already turned away, so the channel there is wider than the
   *     border (~40 mm vs 27.5 at the defaults) and a nominal-width band would
   *     leave part of it open. Everything inboard of the cavity wall is removed
   *     by channelSolid's own cavity cut, and the half-plane cannot reach the
   *     opposite rail.
   *   - the socket footprint dilated by one wall thickness, `seamProfile(...,
   *     dovetailClear + wallThick)`. It contains the tang footprint (so the tang
   *     piece gets the dovetail prism the fold is cut from) and stands
   *     `wallThick` off the slot on both flanks and at its far end (so the
   *     socket piece gets flanks and the tang bottoms out against material).
   *
   * A collar wider than the channel is trimmed, not clamped — a dovetail wider
   * than the border just merges into the walls, which is if anything stronger.
   *
   * The tang is a FOLD, not a solid: seamCore removes its interior, so the
   * dovetail is one wall thick all round — like the rest of the frame, and like
   * the ground truth. Above roughly wallThick = w/2 * cos(angle) the erosion
   * degenerates and it comes out solid again on its own.
   */
  const seams: Seam[] = [];
  for (const sy of [1, -1] as const) {
    // Corner joints: the rail owns the tang and it protrudes outward into the cap.
    seams.push({ axis: "X", pos: splitX, band: sy * yc, dir: 1, side: sy, from: 0 });
    seams.push({ axis: "X", pos: -splitX, band: sy * yc, dir: -1, side: sy, from: 0 });
    // Interior rail bed splits: sliceSegments gives the lower segment the tang.
    for (const cx of cutsLong) seams.push({ axis: "X", pos: cx, band: sy * yc, dir: 1, side: sy, from: 0 });
  }
  // End-cap bed splits. Unlike a rail seam these must be held off the centre:
  // at |y| past the cavity the whole x range is long-rail border, so a
  // half-plane from 0 would drop a stray transverse wall across a rail.
  for (const ex of [1, -1] as const)
    for (const cy of cutsEnd) seams.push({ axis: "Y", pos: cy, band: ex * xcEnd, dir: 1, side: ex, from: splitX });

  const web = ({ axis, pos, side, from }: Seam): Drawing => {
    const b0 = Math.min(side * from, side * big);
    const b1 = Math.max(side * from, side * big);
    return axis === "X" ? rect(pos - wb, pos + wb, b0, b1) : rect(b0, b1, pos - wb, pos + wb);
  };
  const footprint = seams
    .map((s) => web(s).fuse(seamProfile(s.axis, s.pos, s.band, s.dir, c + wb)))
    .reduce((a, b) => a.fuse(b));
  // Hollow the tangs BEFORE the frame is fused in: cutting from `bulkheads`
  // rather than `joined` confines the cut to the channel's own material, so it
  // can never reach the frame's actual walls or floor (channelSolid is
  // strictly the hollow between them). The floor itself rarely reaches the
  // fold -- the same measurement quoted in this file's header, that the bottom
  // fillet pulls the outer footprint inboard of the corner tang band -- so it
  // is not what closes the fold at the bottom. What does, at the shipped
  // bottom-corner radius, is that same fillet: it narrows the channel below the
  // eroded band (around z ~= 2.9 mm) until there is no bulkhead material left
  // for seamCore to remove, so the tang comes out solid there. The fold is
  // therefore closed at the bottom and open at the top, on a floor steeper than
  // 30 deg -- it prints without support and still assembles by sliding down.
  // Open at the BACK too, into the channel, which is what makes it a fold
  // rather than a pocket; see seamCore.
  // The socket piece's region already subtracts the clearance-grown tang, so it
  // never owned the material being removed here and needs no change.
  const bulkheads = channelSolid(p, wallInner, footprint);
  const cores = seams
    .map((s) => seamCore(s.axis, s.pos, s.band, s.dir))
    .filter((d): d is Drawing => d !== null);
  const joined = frame.fuse(
    cores.length ? (bulkheads.cut(solid(cores.reduce((a, b) => a.fuse(b)))) as Shape3D) : bulkheads,
  );

  // Slice a featured rail/cap `body` (already the U-channel wall profile) into N
  // in-line segments along `axis`, joined by a wall-profile dovetail at each
  // interior seam. The key follows the wall — like the corner joints — because
  // it is built by adding/removing the tang FOOTPRINT to a segment's 2-D region
  // and intersecting the body, NOT by fusing a solid prism (which would leave a
  // solid block). `band` is the seam's centre on the off-axis. Only the slice
  // `axis` is bounded into segments; the cross-axis spans the full half-plane
  // (±big) so the body's own features are never clipped here — an end-cap rib
  // protrudes past the wall face into the cavity, and clipping the cross-axis at
  // the face (as an earlier version did) shears the rib off. Each seam: left
  // segment gets the tang (region ∪ footprint), right the grown socket (− footprint).
  const sliceSegments = (
    body: Shape3D,
    axis: "X" | "Y",
    n: number,
    cuts: number[],
    band: number,
  ): Shape3D[] => {
    if (n === 1) return [body];
    const bounds = [-big, ...cuts, big];
    const seg = (a0: number, a1: number): Drawing =>
      axis === "X" ? rect(a0, a1, -big, big) : rect(-big, big, a0, a1);
    return Array.from({ length: n }, (_, i) => {
      let region = seg(bounds[i], bounds[i + 1]);
      if (i < n - 1) region = region.fuse(seamProfile(axis, cuts[i], band, 1)); // male tang past the far seam
      if (i > 0) region = region.cut(seamProfile(axis, cuts[i - 1], band, 1, c)); // socket at the near seam
      return body.clone().intersect(solid(region));
    });
  };

  // One long side-rail (sy = +1 top / -1 bottom): the full featured rail, then
  // sliced into nLong in-line segments. Features/dividers are applied to the
  // whole rail first so slicing (intersect) clips them per segment. Dividers
  // are fused BEFORE the grid groove cut (not after) — same reasoning as the
  // unsplit path in buildPerimeter: a divider sits at the same X as a grid
  // module centre, so cutting the groove last is what keeps it open instead of
  // the divider's fuse silently refilling it.
  const longSegments = (sy: 1 | -1): Shape3D[] => {
    const y0 = sy > 0 ? 0 : -big;
    const y1 = sy > 0 ? big : 0;
    const region0 = rect(-splitX, splitX, y0, y1)
      .fuse(seamProfile("X", splitX, sy * yc, 1))
      .fuse(seamProfile("X", -splitX, sy * yc, -1));
    const kind = sy > 0 ? "groove" : "rib";
    const rail = applyGridFeatures(div(joined.clone().intersect(solid(region0)), sy), p, wallSpec("Y", sy, kind));
    return sliceSegments(rail, "X", nLong, cutsLong, sy * yc);
  };

  // One end cap (ex = +1 right / -1 left): full-width beyond the split with the
  // corners and their (grown) sockets, sliced into nEnd segments along Y.
  const endSegments = (ex: 1 | -1): Shape3D[] => {
    const x0 = ex > 0 ? splitX : -big;
    const x1 = ex > 0 ? big : -splitX;
    const kind = ex > 0 ? "rib" : "groove";
    const cap = applyGridFeatures(joined.clone().intersect(solid(rect(x0, x1, -big, big))), p, wallSpec("X", ex, kind))
      .cut(solid(seamProfile("X", ex * splitX, yc, ex, c)))
      .cut(solid(seamProfile("X", ex * splitX, -yc, ex, c)));
    return sliceSegments(cap, "Y", nEnd, cutsEnd, ex * xcEnd);
  };

  return [...longSegments(1), ...longSegments(-1), ...endSegments(1), ...endSegments(-1)];
}

/**
 * Deliberate deviation from the ground truth: `wallThick` and `footThick`
 * default to 3 mm / 4 mm, not the Fusion originals' 1.2 mm / 1 mm. The source
 * design is a thin liner glued inside a rigid case; the generator ships a
 * self-supporting frame meant to be printed and used standalone, so it defaults
 * to heavier walls and floor. Neither drives the registration interface
 * (rib/socket widths, grid pitch, bumps derive from RIB_WIDTH/GRID_BUMP — see
 * registration.ts), so parts still interlock at any thickness. Set them back to
 * 1.2 / 1 mm to reproduce the original geometry. See README "Intentional
 * deviations from the ground truth".
 *
 * RIB_WIDTH (the "Grid bump width" knob, shared with the bins) deviates from
 * the originals too — 3 mm rather than 1.2 mm, for printability. That one IS an
 * interface dimension; see the note on `ribWidthParam` in registration.ts.
 */
export const perimeterParams: ParamDef[] = [
    { key: "overallLength", fusionName: "OVERALL_LENGTH", label: "Case length", default: 350, unit: "mm", min: 60, max: 900, step: 1 },
    { key: "overallWidth", fusionName: "OVERALL_WIDTH", label: "Case width", default: 250, unit: "mm", min: 60, max: 900, step: 1 },
    { key: "overallHeight", fusionName: "OVERALL_HEIGHT", label: "Case depth", default: 110, unit: "mm", min: 10, max: 400, step: 1 },
    { key: "bottomCornerRadius", fusionName: "BOTTOM_CORNER_RADIUS", label: "Bottom corner radius", default: 19.05, unit: "mm", min: 1, max: 60, step: 0.05 },
    { key: "wallCornerRadius", fusionName: "WALL_CORNER_RADIUS", label: "Cavity corner radius", default: 15.5, unit: "mm", min: 1, max: 60, step: 0.5 },
    { key: "sideWallTaper", fusionName: "SIDE_WALL_TAPER", label: "Side wall taper", default: 2, unit: "deg", min: 0, max: 15, step: 0.5 },
    { key: "frontWallTaper", fusionName: "FRONT_WALL_TAPER", label: "Front wall taper", default: 2, unit: "deg", min: 0, max: 15, step: 0.5 },
    { key: "wallThick", fusionName: "WALL_THICK", label: "Wall thickness", default: 3, unit: "mm", min: 0.4, max: 6, step: 0.1 },
    ribWidthParam,
    draftAngleParam,
    { key: "clearance", fusionName: "CLEARANCE", label: "Case clearance", default: 0, unit: "mm", min: 0, max: 1, step: 0.05 },
    { key: "gridSpacing", fusionName: "GRID_SPACING", label: "Grid spacing", default: 15, unit: "mm", min: 10, max: 50, step: 0.5 },
    { key: "gridBump", fusionName: "GRID_BUMP", label: "Grid bump", default: 1.5, unit: "mm", min: 0, max: 3, step: 0.1 },
    { key: "sideBoarderBinAdd", fusionName: "SIDE_BOARDER_BIN_ADD", label: "Side border bins", default: 4, unit: "", min: 0, max: 10, step: 1 },
    { key: "frontBoarderBinAdd", fusionName: "FRONT_BOARDER_BIN_ADD", label: "Front border bins", default: 3, unit: "", min: 0, max: 10, step: 1 },
    { key: "footThick", label: "Floor thickness", default: 4, unit: "mm", min: 0.6, max: 6, step: 0.2 },
    { key: "dividers", fusionName: "BOARDER_DIVIDERS", label: "Dividers per long side", default: 4, unit: "", min: 0, max: 12, step: 1 },
    { key: "split", type: "boolean", label: "Split into pieces", default: true },
    { key: "bedWidth", label: "Printer bed width (0 = no limit)", default: 0, unit: "mm", min: 0, max: 1000, step: 1 },
    { key: "bedDepth", label: "Printer bed depth (0 = no limit)", default: 0, unit: "mm", min: 0, max: 1000, step: 1 },
    { key: "bedMargin", label: "Bed margin (per side)", default: 5, unit: "mm", min: 0, max: 30, step: 1 },
    { key: "dovetailWidth", fusionName: "BOARDER_DOVETAIL_WIDTH", label: "Dovetail width", default: 10, unit: "mm", min: 4, max: 30, step: 0.5 },
    { key: "dovetailDepth", fusionName: "BOARDER_DOVETAIL_DEPTH", label: "Dovetail depth", default: 5, unit: "mm", min: 2, max: 15, step: 0.5 },
    { key: "dovetailAngle", fusionName: "BOARDER_DOVETAIL_ANGLE", label: "Dovetail angle", default: 30, unit: "deg", min: 0, max: 45, step: 1 },
    { key: "dovetailClear", fusionName: "BOARDER_DOVETAIL_CLEAR", label: "Dovetail clearance", default: 0.2, unit: "mm", min: 0, max: 1, step: 0.05 },
];

export function buildPerimeter(p: ParamValues): Shape3D | Shape3D[] {
    const h = p.overallHeight;
    const t = p.wallThick;

    // Outer (case) wall: tapered thin tube, open top and bottom.
    // Coplanar top/bottom caps on purpose: extending the cutter past the ends
    // leaves boolean debris on tapered lofts, and OCCT shell() fails outright.
    // Build the outer block once and reuse it (wall cut, divider bounding).
    const outer = outerLoft(0, p);
    const wallInner = outerLoft(t, p);
    const outerWall = outer.clone().cut(wallInner.clone());

    // Inner (cavity) wall: vertical thin tube on the border side of the cavity.
    const innerWall = (cavityAt(0, t, p) as Sketch)
      .extrude(h)
      .cut((cavityAt(0, 0, p) as Sketch).extrude(h)) as Shape3D;

    // Floor closing the bottom of the channel. Its outer edge follows the pulled-
    // in bottom footprint of the filleted wall (outerAt at z=0), so it is the
    // narrow band the real foot is, and it overlaps the wall base to fuse into
    // one connected solid.
    const floor = (outerAt(0, 0, p) as Sketch)
      .extrude(p.footThick)
      .cut((cavityAt(0, 0, p) as Sketch).extrude(p.footThick)) as Shape3D;

    let frame = (outerWall as Shape3D).fuse(innerWall).fuse(floor);
    // Thicken the near-horizontal base of the fillet up to FLOOR_THICK — see
    // floorCollar.
    const collar = floorCollar(p, wallInner);
    if (collar) frame = frame.fuse(collar);
    // When splitting, grid features + dividers are added per piece (splitPieces);
    // otherwise apply them to the whole frame. `wallInner` goes along for the
    // ride: splitPieces needs it to carve the seam bulkheads out of the channel,
    // and rebuilding that loft is the single most expensive thing in the model.
    // `split` is a checkbox in the UI but the analysis scripts pass 0/1, so read
    // it through boolParam rather than trusting either representation.
    if (boolParam(p, "split", true)) return splitPieces(frame, p, wallInner);
    // Dividers FIRST, grid features (grooves) LAST: a divider coincides in X
    // with a grid module centre by construction (dividerCenters draws from the
    // same set gridCenters does), so on the +Y/-X (groove) walls a divider's
    // additive fuse would otherwise refill whatever a groove cut had carved out
    // there. Cutting the groove last guarantees it always wins — it stays a
    // clean blind pocket even where a divider crosses it (the wider backing
    // boss keeps the divider connected to the frame either side of the notch).
    let out = p.dividers > 0 ? addDividers(addDividers(frame, p, 1), p, -1) : frame;
    if (p.gridBump > 0) out = applyGridFeatures(out, p);
    return out;
}

export const perimeter: ModelDef = {
  id: "perimeter",
  name: "Perimeter (frame)",
  description:
    "Liner frame that drops into the hard case: a tapered U-channel border " +
    "around a gridded cavity, split into dovetailed pieces for printing (enter a " +
    "printer bed size to auto-subdivide so every piece fits), with grid bumps, " +
    "configurable dividers and print clearances.",
  params: perimeterParams,
  presets: [
    { label: "Apache 3800", values: { overallLength: 377.825, overallWidth: 268.2875, overallHeight: 110 } },
    { label: "Apache 4800", values: { overallLength: 454.025, overallWidth: 323.85, overallHeight: 125 } },
  ],
  groups: [
    { title: "Basic dimensions", collapsed: false, keys: ["overallLength", "overallWidth", "overallHeight", "wallThick", "footThick"] },
    { title: "Advanced dimensions", collapsed: true, keys: ["bottomCornerRadius", "wallCornerRadius", "sideWallTaper", "frontWallTaper", "clearance"] },
    { title: "Interior features", collapsed: true, keys: ["sideBoarderBinAdd", "frontBoarderBinAdd", "dividers"] },
    { title: "Module features", collapsed: true, keys: ["gridSpacing", "gridBump", "ribWidth", "draftAngle"] },
    { title: "Printer convenience", collapsed: false, keys: ["split", "bedWidth", "bedDepth", "bedMargin", "dovetailWidth", "dovetailDepth", "dovetailAngle", "dovetailClear"] },
  ],
  build: buildPerimeter,
};
