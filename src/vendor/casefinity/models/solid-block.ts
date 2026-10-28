import type { ModelDef } from "./types.ts";
import type { ParamValues } from "./types.ts";
import { binParams, buildBinBody } from "./bin-common.ts";

/**
 * A completely filled "Bin (no lid)": same outer footprint, interlock ribs,
 * sockets and pull tab, but with no interior cavity. Intended to be exported
 * and dropped into CAD as stock for custom tool holders — subtract pockets to
 * taste. No STEP ground truth exists (it is not one of the original .f3d
 * models); the smoke test locks in its self-derived bbox/volume as a
 * regression guard.
 */
export const solidBlock: ModelDef = {
  id: "solid-block",
  name: "Solid Block",
  description:
    "A completely filled bin: the Bin (no lid) footprint with interlock ribs, " +
    "sockets and pull tab, but no interior cavity. Export it and subtract your " +
    "own pockets in CAD to make custom tool holders.",
  params: binParams,
  groups: [
    { title: "Basic dimensions", collapsed: false, keys: ["widthModules", "lengthModules", "overallHeight", "wallThick", "floorThick", "clear", "pullTabHeight", "pullHoleLength", "lidPullHeight"] },
    { title: "Module features", collapsed: true, keys: ["gridSpacing", "ribWidth", "wallBump", "draftAngle"] },
  ],
  build: (p: ParamValues) => buildBinBody(p, true),
};
