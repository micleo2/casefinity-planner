import { strToU8, zipSync } from "fflate";
import type { Zippable } from "fflate";
import type { Remote } from "comlink";
import type { CadWorkerApi, ExportFormat } from "./worker.ts";
import { binParams, fileStem, modelIdFor } from "./bins.ts";
import type { Layout } from "./bins.ts";
import { serializeLayout } from "./layout.ts";

/**
 * Batch export: every bin in the layout → one ZIP. Identical bins (same model,
 * parameters and title) are built once and written as a single file with an
 * `_xN` quantity suffix, since you print N copies of one STL anyway.
 */

export interface PartGroup {
  stem: string;
  modelId: string;
  params: ReturnType<typeof binParams>;
  count: number;
}

export function groupParts(layout: Layout): PartGroup[] {
  const groups = new Map<string, PartGroup>();
  for (const bin of layout.bins) {
    const modelId = modelIdFor(bin.type);
    const params = binParams(bin, layout.settings);
    const stem = fileStem(bin);
    const key = JSON.stringify([stem, modelId, params]);
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { stem, modelId, params, count: 1 });
  }
  // Two different bins can share a stem (same size/title/type, other height):
  // disambiguate so neither overwrites the other in the ZIP.
  const seen = new Map<string, number>();
  return [...groups.values()].map((g) => {
    const n = (seen.get(g.stem) ?? 0) + 1;
    seen.set(g.stem, n);
    return n === 1 ? g : { ...g, stem: `${g.stem}_v${n}` };
  });
}

/** Built files by (model, params, format) — rebuilding is the slow part. */
const cache = new Map<string, Uint8Array>();

export async function exportZip(
  cad: Remote<CadWorkerApi>,
  layout: Layout,
  formats: ExportFormat[],
  progress: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const groups = groupParts(layout);
  const files: Zippable = {};
  for (const [i, g] of groups.entries()) {
    progress(i, groups.length);
    const keyOf = (f: ExportFormat) => JSON.stringify([g.modelId, g.params, f]);
    const missing = formats.filter((f) => !cache.has(keyOf(f)));
    if (missing.length) {
      const built = await cad.exportBin(g.modelId, g.params, missing, g.stem);
      for (const f of missing) cache.set(keyOf(f), built[f]!);
    }
    const name = g.count > 1 ? `${g.stem}_x${g.count}` : g.stem;
    for (const f of formats) {
      // 3MF is already a zip; STL and STEP compress well
      files[`${f}/${name}.${f}`] = [cache.get(keyOf(f))!, { level: f === "3mf" ? 0 : 6 }];
    }
  }
  progress(groups.length, groups.length);
  files["layout.json"] = strToU8(serializeLayout(layout));
  return zipSync(files);
}
