import { draw, drawText, drawCircle } from "replicad";
import type { Shape3D, Sketch } from "replicad";
import type { ModelDef, ParamValues } from "./types.ts";
import { textParam } from "./types.ts";
import { binParams, binSocketCutterX, buildBinBody, box, draftedBox, withDefaults } from "./bin-common.ts";
import { interlockDims, moduleCenters } from "./registration.ts";

/**
 * Port of Hardcase_Gridfinity_Bin with Lid.f3d: the shared bin body plus a
 * sliding lid, modeled in place (as in the original file).
 *
 * The lid is a LID_THICK plate whose top face is flush with the bin rim,
 * carrying a half-round rail bead on each long edge. The beads run the full
 * slide length and seat in a shallow scallop groove — in the -X wall itself,
 * and in the interior bosses on +X (which stand WALL_BUMP proud of that wall).
 * Over the last LID_LOCK_LENGTH at the entry edge both beads swell and the
 * plate underside steps down, giving a deliberate interference fit: that swell
 * is the lock that holds the lid shut. The lid slides in from -Y and tucks
 * under the pull tab at +Y.
 *
 * Geometry recovered from ground truth (all values verified against
 * "Hardcase_Gridfinity_Bin with Lid.step" at the original parameters):
 *
 *   plate         z 107.0 .. 110.0, x -21.10 .. 19.60, y -22.30 .. 21.10
 *   rail bead     half-round r 0.6, axis on the plate underside (z 107.6),
 *                 both edges, full length; section 0.565 mm^2 = pi r^2 / 2
 *   lock swell    -X r 0.9, +X r 0.75, over the last 8 mm (LID_LOCK_LENGTH)
 *   lock pad      plate underside steps down LID_CLEAR over the same 8 mm
 *   interference  4.71 mm^3, all of it inside the lock zone
 *   wall groove   the rail bead offset by LID_CLEAR (r 0.7) — measured groove
 *                 section 0.630 mm^2 matches that offset circle exactly
 *   finger pull   the first LID_PULL_FRONT_OFFSET mm stay at rim height, then
 *                 the top drops LID_PULL_HT and ramps back up over
 *                 LID_PULL_WIDTH; 1 mm rails left at each x edge
 *   notches       socket-width slots WALL_THICK + CLEAR deep at each
 *                 width-module centre on the entry edge
 *
 * The body's lid seat is cut with a *shrunk* cutter (the running bead, no lock
 * swell) so the lock's interference survives. Cutting the lid itself out of the
 * body would machine the groove to a perfect fit and leave nothing holding the
 * lid — see scripts/smoke.mjs, which asserts the interference is present and
 * confined to the lock zone.
 *
 * "TOP" is engraved on the lid's top face using the bundled LiberationSans
 * font (loaded by the worker / smoke bootstrap).
 *
 * Corrections to earlier readings of the ground truth, for the record: the lid
 * is not offset downward by LID_LOCK_OFFSET (its top is flush with the rim —
 * LID_LOCK_OFFSET is the bead's radial swell); the entry edge is not solid at
 * module centres (it carries the three socket notches); and the plate has no
 * rounded plan corners or top-edge round — the area once read as corner rounds
 * was those notches.
 */

/** Where the lid sits, shared by the lid, the seat cutter and the rail ledge. */
function lidFrame(p: ParamValues) {
  const w = p.widthModules * p.gridSpacing - 2 * p.clear;
  const d = p.lengthModules * p.gridSpacing - 2 * p.clear;
  const h = p.overallHeight;
  const t = p.wallThick;
  return {
    w,
    d,
    h,
    zTop: h, // flush with the rim
    zBottom: h - p.lidThick,
    // LID_CLEAR clear of the -X wall's inner face, and of the +X interior
    // bosses (which stand WALL_BUMP proud of the +X wall's inner face)
    xMin: -(w / 2 - t) + p.lidClear,
    xMax: w / 2 - t - p.wallBump - p.lidClear,
    // flush with the outer -Y face at the entry, just short of the +Y wall
    yEntry: -d / 2 + p.clear,
    yFar: d / 2 - t - p.lidClear,
  };
}

/**
 * The +X rail ledge. On -X the bead's groove is cut straight into the wall, but
 * the +X wall's inner face is a WALL_BUMP step back from the lid's edge — there
 * is only material to groove at the interior sockets' backing bosses. The
 * ground truth therefore runs a continuous ledge, WALL_BUMP proud and the full
 * length of the bin, from the lid's seat underside up to the rim, so the rail
 * bead is supported everywhere instead of at three module centres. Its underside
 * is chamfered at 45 degrees over WALL_BUMP so it prints without support.
 * (Measured: full depth from z 106.8, chamfer running out at z 105.3.)
 */
function addLidRailLedge(body: Shape3D, p: ParamValues): Shape3D {
  const f = lidFrame(p);
  const xInner = f.w / 2 - p.wallThick; // the +X wall's inner face
  const zLedge = f.zBottom - p.lidClear; // the seat's underside
  let ledge = box(p.wallBump, f.d, zLedge, f.zTop, xInner - p.wallBump / 2, 0);
  const chamfer = draw([xInner, zLedge - p.wallBump])
    .lineTo([xInner, zLedge])
    .lineTo([xInner - p.wallBump, zLedge])
    .close();
  ledge = ledge.fuse(
    (chamfer.sketchOnPlane("XZ", -f.d / 2) as Sketch).extrude(f.d) as Shape3D,
  );
  // The interlock sockets are cut through this wall before the ledge exists, so
  // re-cut them or the ledge plugs them from the inside. Same drafted cutter the
  // body used (binSocketCutterX) — a plain box here would step the slot's width
  // partway up its height.
  for (const c of moduleCenters(p.lengthModules, p.gridSpacing)) {
    ledge = ledge.cut(draftedBox(binSocketCutterX(p, f.w, c), p, 0, f.h));
  }
  return body.fuse(ledge);
}

/** A cylinder along Y, spanning y0..y1, centred on (xAxis, zAxis). */
function railBead(xAxis: number, zAxis: number, r: number, y0: number, y1: number): Shape3D {
  // "XZ" plane at offset -y1 places the sketch at y = y1; the extrude runs
  // back toward -Y, so the bead spans [y0, y1].
  return (drawCircle(r)
    .translate(xAxis, zAxis)
    .sketchOnPlane("XZ", -y1) as Sketch).extrude(y1 - y0) as Shape3D;
}

/**
 * The lid. `forSeat` builds the cutter that carves the seat into the body
 * instead of the lid itself: the same swept envelope grown by LID_CLEAR, with
 * the lock swell, the finger scoop and the notches left off. The lock beads are
 * therefore larger than the groove the cutter leaves, which is the interference
 * that locks the lid shut.
 */
function buildLid(p: ParamValues, forSeat = false): Shape3D {
  const f = lidFrame(p);
  const clr = forSeat ? p.lidClear : 0;
  const zBottom = f.zBottom - clr;
  // The seat cutter runs past the mouth and above the rim so no cut face lands
  // coplanar with the bin's own faces.
  const yEntry = forSeat ? f.yEntry - 1 : f.yEntry;
  const zTop = forSeat ? f.zTop + 1 : f.zTop;

  let lid = box(f.xMax - f.xMin + 2 * clr, f.yFar - yEntry, zBottom, zTop,
    (f.xMin + f.xMax) / 2, (yEntry + f.yFar) / 2);

  // Rail beads: half-round, tangent to the plate underside, running the full
  // slide length. Fused as full cylinders — the inner half merges into the
  // plate, the outer half is the bead. The radius is clamped to half the lid
  // thickness so a hand-set rail can never stand proud of the top face (same
  // pattern as addPullTab's gusset clamp); at the defaults the clamp is
  // inactive (0.6 against a 1.5 mm ceiling).
  const rRail = Math.min(p.lidRailRadius, p.lidThick / 2);
  const rRun = rRail + clr;
  const zAxis = f.zBottom + rRail;
  lid = lid.fuse(railBead(f.xMin, zAxis, rRun, yEntry, f.yFar));
  lid = lid.fuse(railBead(f.xMax, zAxis, rRun, yEntry, f.yFar));

  if (forSeat) return lid;

  // The lock: over the last LID_LOCK_LENGTH at the entry edge both beads swell
  // and the plate underside steps down, so the lid has to be pressed past an
  // interference to close. The -X bead (seated in the wall) takes the full
  // LID_CLEAR + LID_LOCK_OFFSET; the shallower +X bead (seated in the rail
  // ledge) takes half of it. Swelling past the top face would foul the rim, so
  // the lock radius is capped there too.
  const swell = Math.min(p.lidClear + p.lidLockOffset, p.lidThick - rRail);
  const yLock = Math.min(f.yEntry + p.lidLockLength, f.yFar);
  if (swell > 0 && yLock > f.yEntry) {
    lid = lid.fuse(railBead(f.xMin, zAxis, rRail + swell, f.yEntry, yLock));
    lid = lid.fuse(railBead(f.xMax, zAxis, rRail + swell / 2, f.yEntry, yLock));
    // The pad takes up the sliding clearance under the plate; with no clearance
    // to take up there is nothing to add.
    if (p.lidClear > 0) {
      lid = lid.fuse(box(f.xMax - f.xMin, yLock - f.yEntry, f.zBottom - p.lidClear, f.zBottom,
        (f.xMin + f.xMax) / 2, (f.yEntry + yLock) / 2));
    }
  }

  // Finger pull: the first LID_PULL_FRONT_OFFSET mm stay at rim height so a
  // fingernail catches behind them, then the top steps down LID_PULL_HT and
  // ramps back up over LID_PULL_WIDTH. A 1 mm rail is left at each x edge
  // (measured), which also keeps the scoop clear of the rail beads.
  const railInset = 1;
  const yStep = f.yEntry + p.lidPullFrontOffset;
  const yRamp = Math.min(yStep + p.lidPullWidth, f.yFar);
  if (yRamp > yStep && f.xMax - f.xMin > 2 * railInset) {
    const scoop = draw([yStep, f.zTop - p.lidPullHeight])
      .lineTo([yRamp, f.zTop])
      .lineTo([yRamp, f.zTop + 1])
      .lineTo([yStep, f.zTop + 1])
      .close();
    lid = lid.cut(
      (scoop.sketchOnPlane("YZ", f.xMin + railInset) as Sketch)
        .extrude(f.xMax - f.xMin - 2 * railInset) as Shape3D,
    );
  }

  // Both of the next two features act on the lid's nose: the part still buried
  // in the -Y wall once the lid is home, WALL_THICK + CLEAR deep.
  const noseDepth = p.wallThick + p.clear;
  const noseCentre = f.yEntry + (noseDepth - 1) / 2; // for a (noseDepth + 1) box

  // Mouth relief: the nose sits LID_CLEAR below the rim so it cannot bind on
  // the wall as it goes in (measured 0.10 deep over the first 1.3 mm).
  if (p.lidClear > 0) {
    lid = lid.cut(box(f.xMax - f.xMin, noseDepth + 1, f.zTop - p.lidClear, f.zTop + 1,
      (f.xMin + f.xMax) / 2, noseCentre));
  }

  // Entry-edge notches: the -Y wall's interlock sockets run the full height of
  // the bin, so the nose has to be slotted at each width-module centre or it
  // caps them and a neighbouring bin's rib can no longer plug in.
  //
  // Deliberately NOT drafted like the socket it clears: this is relief, not
  // registration. A straight socketWidth cut equals the drafted socket at its
  // widest (the wall face) and is wider everywhere deeper, so it can never
  // shadow the slot.
  const { socketWidth } = interlockDims(p, p.wallBump);
  for (const c of moduleCenters(p.widthModules, p.gridSpacing)) {
    lid = lid.cut(box(socketWidth, noseDepth + 1, f.zBottom - 2, f.zTop + 1, c, noseCentre));
  }

  // Engrave the label on the top face
  const label = textParam(p, "lidLabel", "TOP");
  if (label) {
    try {
      const fontSize = 8;
      const engraveDepth = 0.5;
      // Centre the text on the lid using the text's bounding box.
      // NOTE: Drawing.translate() is broken (doesn't move geometry),
      // so we measure first, then draw at the computed position.
      const cx = (f.xMin + f.xMax) / 2;
      const cy = (f.yEntry + f.yFar) / 2; // plate centre, clear of the scoop
      // Measure the text at origin to find its centre offset
      const measureDrawing = drawText(label, {
        fontFamily: "LiberationSans",
        fontSize,
        startX: 0,
        startY: 0,
      });
      const bb = measureDrawing.boundingBox;
      const [bbMin, bbMax] = bb.bounds;
      const textCX = (bbMin[0] + bbMax[0]) / 2;
      const textCY = (bbMin[1] + bbMax[1]) / 2;
      // Now draw at the correct position
      const textDrawing = drawText(label, {
        fontFamily: "LiberationSans",
        fontSize,
        startX: cx + textCX,
        startY: cy - textCY,
      });
      const textSketch = textDrawing.sketchOnPlane("XY", f.zTop - engraveDepth) as Sketch;
      lid = lid.cut(textSketch.extrude(engraveDepth + 0.1) as Shape3D);
    } catch (_err) {
      // Text ops can fail if the font isn't loaded; skip engraving gracefully
      console.warn("Lid text engraving failed — skipping");
    }
  }

  return lid;
}

export const binWithLid: ModelDef = {
  id: "bin-with-lid",
  name: "Bin with lid",
  description:
    "Bin plus a sliding lid that locks shut under the pull tab. " +
    "Optional engraved label on the lid.",
  params: [
    ...withDefaults(binParams, { pullHoleLength: 12 }),
    { key: "lidThick", fusionName: "LID_THICK", label: "Lid thickness", default: 3, unit: "mm", min: 1, max: 6, step: 0.5 },
    { key: "lidClear", fusionName: "LID_CLEAR", label: "Lid clearance", default: 0.1, unit: "mm", min: 0, max: 0.5, step: 0.05 },
    { key: "lidLockOffset", fusionName: "LID_LOCK_OFFSET", label: "Lid lock grip", default: 0.2, unit: "mm", min: 0, max: 1, step: 0.1 },
    { key: "lidLockLength", fusionName: "LID_LOCK_LENGTH", label: "Lid lock length", default: 8, unit: "mm", min: 0, max: 30, step: 1 },
    // No Fusion name: the originals drew the bead directly. 0.6 is the measured
    // ground-truth radius (numerically WALL_THICK / 2 at the original 1.2 mm
    // wall), frozen here so a structural wall change does not resize the rail.
    { key: "lidRailRadius", label: "Lid rail radius", default: 0.6, unit: "mm", min: 0.3, max: 1.5, step: 0.1 },
    { key: "lidPullFrontOffset", fusionName: "LID_PULL_FRONT_OFFSET", label: "Finger lip width", default: 3, unit: "mm", min: 0, max: 10, step: 0.5 },
    { key: "lidPullWidth", fusionName: "LID_PULL_WIDTH", label: "Finger scoop length", default: 8, unit: "mm", min: 0, max: 30, step: 1 },
    { key: "lidLabel", fusionName: "LID_LABEL", type: "text", label: "Lid label", default: "TOP" },
  ],
  groups: [
    { title: "Basic dimensions", collapsed: false, keys: ["widthModules", "lengthModules", "overallHeight", "wallThick", "floorThick", "clear", "pullTabHeight", "pullHoleLength", "lidPullHeight", "lidLabel"] },
    { title: "Advanced dimensions", collapsed: true, keys: ["lidThick", "lidClear", "lidLockOffset", "lidLockLength", "lidRailRadius", "lidPullFrontOffset", "lidPullWidth"] },
    { title: "Module features", collapsed: true, keys: ["gridSpacing", "ribWidth", "wallBump", "draftAngle"] },
  ],
  build(p) {
    const lid = buildLid(p);
    // Carve the seat with the shrunk cutter, not the lid: the groove must be
    // sized for the running bead so the lock swell still interferes.
    const body = addLidRailLedge(buildBinBody(p), p).cut(buildLid(p, true)) as Shape3D;
    return [body, lid];
  },
};
