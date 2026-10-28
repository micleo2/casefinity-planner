import type { ModelDef } from "./types.ts";
import { binParams, buildBinBody } from "./bin-common.ts";

/**
 * Port of Hardcase_Gridfinity_Bin No Lid.f3d — the shared bin body only.
 * Verified against ground truth: bbox exact, volume within 0.02%.
 */
export const binNoLid: ModelDef = {
  id: "bin-no-lid",
  name: "Bin (no lid)",
  description:
    "Open bin that packs into the perimeter grid. Exterior ribs on two faces " +
    "snap into sockets on the neighbouring bin; one wall carries a pull tab " +
    "with a finger slot.",
  params: binParams,
  groups: [
    { title: "Basic dimensions", collapsed: false, keys: ["widthModules", "lengthModules", "overallHeight", "wallThick", "floorThick", "clear", "pullTabHeight", "pullHoleLength", "lidPullHeight"] },
    { title: "Module features", collapsed: true, keys: ["gridSpacing", "ribWidth", "wallBump", "draftAngle"] },
  ],
  build: buildBinBody,
};
