import type { ModelDef, ParamDef, ParamValues } from "./types.ts";
import {
  box,
  addInterlockRibs,
  addPullTab,
  binParams,
  withDefaults,
} from "./bin-common.ts";
import { drawRectangle } from "replicad";
import type { Shape3D, Sketch } from "replicad";

/**
 * Port of Hardcase_Gridfinity_Bin Double Sided.step — an open-ended tube
 * usable from both ends, with a central floor, interlock ribs, a pull tab,
 * and two inset lids (one per end).
 *
 * The central floor is a thin solid membrane at mid-height whose underside
 * scoops down to the walls along a big concave "hopper" fillet (radius ≈
 * interior-half − BOTTOM_FILLET_FACTOR): near the walls the floor reaches down
 * ~15 mm, at the centre it's just the membrane. It's built by cutting that
 * concave dome (a loft that follows the fillet arc) out of a solid floor block.
 *
 * Ground truth (4×4 modules): body 68,178 mm³, two lids ~9,590 mm³ each
 * (total 87,351). This port: body ~68,340, lids ~9,494, total ~87,328 (0.03%).
 */

const doubleSidedParams: ParamDef[] = [
  ...withDefaults(binParams, { widthModules: 4, lengthModules: 4 }),
  { key: "bottomFillet", fusionName: "BOTTOM_FILLET_FACTOR", label: "Hopper fillet inset", default: 2.3, unit: "mm", min: 0, max: 15, step: 0.1 },
];

/**
 * The central floor + hopper as one solid. A solid block fills the interior
 * from the bottom of the fillet up to the membrane top; a concave dome (lofted
 * to follow the corner-fillet arc, tangent to the membrane underside and the
 * walls) is cut from below, leaving the thin membrane and the scooped skirt.
 */
function centralFloor(p: ParamValues, iw: number, id: number): Shape3D {
  const ih = iw / 2;
  const ft = p.floorThick;
  const floorTop = p.overallHeight / 2 + ft; // membrane top, just above mid-height
  const memBottom = floorTop - 2.5 * ft; // membrane underside at the centre
  const r = ih - p.bottomFillet; // fillet radius (leaves a small flat centre)
  const zBottom = memBottom - r; // where the skirt meets the wall
  const HOPPER_CLEAR = 1.3; // calibrated so the scoop matches the ground truth

  // Cavity half-width at height z: the corner fillet arc (plus a small clearance)
  // from the membrane underside down to the wall, clamped to the interior.
  const halfWidth = (z: number): number => {
    const d2 = r * r - (z - (memBottom - r)) ** 2;
    return Math.min(ih - r + (d2 <= 0 ? 0 : Math.sqrt(d2)) + HOPPER_CLEAR, ih - 0.01);
  };
  const span = memBottom - zBottom;
  const zs = [zBottom, zBottom + 0.4 * span, zBottom + 0.7 * span, memBottom - 1, memBottom];
  const sections = zs.map(
    (z) => drawRectangle(2 * halfWidth(z), 2 * halfWidth(z)).sketchOnPlane("XY", z) as Sketch,
  );
  const dome = sections[0].loftWith(sections.slice(1)) as Shape3D;
  return box(iw, id, zBottom, floorTop).cut(dome) as Shape3D;
}

/** A lid: a plate that plugs an end of the tube, chamfered on its outer face
 * (a lead-in), so it's lighter than a solid slab like the ground-truth lids. */
function lid(iw: number, id: number, z0: number): Shape3D {
  const clear = 0.3;
  const thick = 3.3;
  const chamfer = 3.5; // outer-face lead-in; calibrated to the GT lid volume
  const lw = iw - clear;
  const ld = id - clear;
  return (drawRectangle(lw - 2 * chamfer, ld - 2 * chamfer).sketchOnPlane("XY", z0) as Sketch)
    .loftWith(drawRectangle(lw, ld).sketchOnPlane("XY", z0 + thick) as Sketch) as Shape3D;
}

export const binDoubleSided: ModelDef = {
  id: "bin-double-sided",
  name: "Bin (double sided)",
  description:
    "Open-ended tube usable from both sides. A central floor with a scooped " +
    "hopper divides the bin into two compartments; inset lids close each end. " +
    "Interlock ribs and pull tab match the other bin variants.",
  params: doubleSidedParams,
  groups: [
    { title: "Basic dimensions", collapsed: false, keys: ["widthModules", "lengthModules", "overallHeight", "wallThick", "floorThick", "clear", "pullTabHeight", "pullHoleLength", "lidPullHeight", "bottomFillet"] },
    { title: "Module features", collapsed: true, keys: ["gridSpacing", "ribWidth", "wallBump", "draftAngle"] },
  ],
  build(p: ParamValues): Shape3D[] {
    const w = p.widthModules * p.gridSpacing - 2 * p.clear;
    const d = p.lengthModules * p.gridSpacing - 2 * p.clear;
    const h = p.overallHeight;
    const t = p.wallThick;
    const iw = w - 2 * t;
    const id = d - 2 * t;

    // Open tube (through both ends) + central hopper floor + ribs + pull tab.
    let body = box(w, d, 0, h).cut(box(iw, id, -1, h + 1));
    body = body.fuse(centralFloor(p, iw, id));
    body = addInterlockRibs(body, w, d, h, p, 0);
    if (p.pullTabHeight > 0) body = addPullTab(body, w, d, h, p);

    return [body, lid(iw, id, 0), lid(iw, id, h - 3.3)];
  },
};
