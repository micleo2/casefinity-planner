import initOpenCascade from "replicad-opencascadejs/src/replicad_single.js";
import opencascadeWasm from "replicad-opencascadejs/src/replicad_single.wasm?url";
import { setOC, loadFont } from "replicad";
import { expose } from "comlink";
import type { ParamValues } from "./vendor/casefinity/models/index.ts";
import { buildParts, stlBlob, threeMfBlob } from "./vendor/casefinity/exports.ts";
import { stepBytes } from "./step.ts";
import { buildPlate } from "./plateExport.ts";
import type { PlateJob } from "./plateExport.ts";

export type ExportFormat = "stl" | "step" | "3mf";

let ready: Promise<void> | undefined;

function init(): Promise<void> {
  ready ??= (async () => {
    const oc = await initOpenCascade({ locateFile: () => opencascadeWasm });
    setOC(oc as Parameters<typeof setOC>[0]);
    // Lid labels are engraved with this font
    const font = await fetch(`${import.meta.env.BASE_URL}LiberationSans-Regular.ttf`);
    await loadFont(await font.arrayBuffer(), "LiberationSans");
  })();
  return ready;
}

const api = {
  async ready(): Promise<boolean> {
    await init();
    return true;
  },

  /** Build one bin and return serializable face + edge meshes per part, for the preview. */
  async mesh(modelId: string, params: ParamValues) {
    await init();
    const parts = buildParts(modelId, params);
    const meshes = parts.map(({ shape }) => ({
      faces: shape.mesh({ tolerance: 0.05, angularTolerance: 30 }),
      edges: shape.meshEdges(),
    }));
    for (const { shape } of parts) shape.delete();
    return meshes;
  },

  /** One print plate as a 3MF, plus a 3MF of lids for each bin that has them. */
  async exportPlate(jobs: PlateJob[], bedY: number, title: string) {
    await init();
    const { plate, extras } = buildPlate(jobs, bedY, title);
    return { plate, extras };
  },

  /** Build one bin once and serialize it to each requested format. */
  async exportBin(
    modelId: string,
    params: ParamValues,
    formats: ExportFormat[],
    title: string,
  ): Promise<Partial<Record<ExportFormat, Uint8Array>>> {
    await init();
    const parts = buildParts(modelId, params);
    const out: Partial<Record<ExportFormat, Uint8Array>> = {};
    for (const f of formats) {
      if (f === "stl") out.stl = new Uint8Array(await stlBlob(parts).arrayBuffer());
      if (f === "step") out.step = stepBytes(parts);
      if (f === "3mf") out["3mf"] = threeMfBlob(parts, title);
    }
    for (const { shape } of parts) shape.delete();
    return out;
  },
};

export type CadWorkerApi = typeof api;

expose(api);
