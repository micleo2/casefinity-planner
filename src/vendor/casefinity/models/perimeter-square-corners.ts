import type { ModelDef, ParamDef } from "./types.ts";
import { perimeterParams, buildPerimeter } from "./perimeter.ts";
import { withDefaults } from "./bin-common.ts";

/**
 * Beta variant of the standard perimeter (see perimeter.ts): same U-channel
 * border, dovetail split, grid bumps and dividers, but the CAVITY corners are
 * square instead of rounded, so a rectangular bin can occupy the corner-most
 * grid cell flush against the wall instead of being blocked by the rounded
 * arc (`WALL_CORNER_RADIUS` on the standard perimeter carves a chunk out of
 * every corner module — see the README/spec's fit-in-the-corners discussion).
 *
 * The OUTER wall is untouched: it still follows the case's own rounded
 * corner and bottom fillet (`BOTTOM_CORNER_RADIUS`, taper), so the piece
 * seats in the physical hard case exactly like the standard perimeter — only
 * the cavity boundary changes. Realized purely by overriding
 * `wallCornerRadius`'s default (and lower bound) to 0; `cavityAt` in
 * perimeter.ts floors the radius at 0.5 mm internally for a well-behaved
 * sketch, which is visually and functionally square. Reuses `buildPerimeter`
 * wholesale (same pattern as smooth-perimeter.ts), so a fix to the shared
 * frame/grid/divider code applies here too without any duplication.
 *
 * Squaring the corner also removes the grid-feature corner exclusion (which
 * is sized off `wallCornerRadius`), so the outermost module on each wall now
 * gets its own rib/groove right up to the corner — exactly the feature a
 * corner bin needs to register.
 *
 * Caveat (why this is beta): squaring the corner makes the cavity boundary
 * reach slightly further toward the outer wall at the diagonal than the
 * rounded version did. Verified safe at the standard-grid defaults (>25 mm of
 * clearance there, well above the REQ-7.2 structural floor of ~6 mm), but a
 * very tight custom border (small BIN_ADD, or a large BOTTOM_CORNER_RADIUS)
 * should be checked — same responsibility REQ-7.2 already places on the
 * standard perimeter, just closer to the margin here. No STEP ground truth
 * exists (this corner treatment isn't in the original Fusion 360 designs);
 * verified via the scaling/invariant harness instead (`npm run scaling
 * perimeter-square-corners`) and a self-derived bbox/volume in smoke.mjs.
 */
export const perimeterSquareCornersParams: ParamDef[] = withDefaults(perimeterParams, {
  wallCornerRadius: 0,
}).map((p) => (p.key === "wallCornerRadius" ? { ...p, min: 0 } : p));

export const perimeterSquareCorners: ModelDef = {
  id: "perimeter-square-corners",
  name: "Perimeter (square corners, beta)",
  description:
    "Beta: the standard liner frame with a SQUARE cavity (not rounded), so a bin can " +
    "occupy the corner-most grid cell flush against the wall. The outer wall still " +
    "follows the case's own rounded corner/bottom, so it seats the same as the " +
    "standard perimeter. Shares the perimeter frame code.",
  params: perimeterSquareCornersParams,
  build: buildPerimeter,
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
};
