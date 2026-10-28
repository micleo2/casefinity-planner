// Batch export test: builds every unique part of scripts/reference-layout.json
// (the screenshot-ref.jpg layout with one bin of each type) in ONE kernel
// instance, the way the browser worker does for a ZIP export.
//
// Runs garbage collection between parts (as a browser does mid-export) so
// replicad's finalizers fire; --upstream-step swaps in replicad's own STEP
// writer to reproduce the double free that src/step.ts avoids.
// Usage: node --expose-gc scripts/batch-test.mjs [--upstream-step] [layout.json]
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
globalThis.require = require;
globalThis.__dirname = dirname(require.resolve("replicad-opencascadejs/src/replicad_single.js"));
const { default: initOpenCascade } = await import("replicad-opencascadejs/src/replicad_single.js");
const replicad = await import("replicad");
replicad.setOC(await initOpenCascade());
const font = readFileSync(new URL("../public/LiberationSans-Regular.ttf", import.meta.url));
await replicad.loadFont(font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength), "LiberationSans");

const { parseLayout } = await import("../src/layout.ts");
const { groupParts } = await import("../src/export.ts");
const { buildParts, stlBlob, stepBlob } = await import("../src/vendor/casefinity/exports.ts");
const { stepBytes } = await import("../src/step.ts");

const args = process.argv.slice(2);
const upstream = args.includes("--upstream-step");
const file = args.find((a) => !a.startsWith("--")) ?? new URL("./reference-layout.json", import.meta.url);
const step = upstream ? (parts) => stepBlob(parts).size : (parts) => stepBytes(parts).length;
const collect = async () => {
  globalThis.gc?.();
  await new Promise((r) => setTimeout(r, 20)); // let finalizers run
};
const layout = parseLayout(readFileSync(file, "utf8"));
const log = (...a) => process.stderr.write(a.join(" ") + "\n"); // stdout is OCCT's STEP chatter
let failures = 0;
const t0 = performance.now();
for (const g of groupParts(layout)) {
  try {
    const parts = buildParts(g.modelId, g.params);
    const stl = stlBlob(parts).size;
    const stepSize = step(parts);
    for (const { shape } of parts) shape.delete();
    await collect();
    log(`ok   ${g.stem} x${g.count}: STL ${(stl / 1024).toFixed(0)} KiB, STEP ${(stepSize / 1024).toFixed(0)} KiB`);
  } catch (e) {
    failures++;
    log(`FAIL ${g.stem}: ${e?.message ?? e}`);
  }
}
// A print plate: every body lands exactly where the plan put it, on the bed, z = 0.
{
  const { planPlates } = await import("../src/plates.ts");
  const { buildPlate } = await import("../src/plateExport.ts");
  const { binParams, modelIdFor, fileStem } = await import("../src/bins.ts");
  const s = layout.settings;
  const plan = planPlates(layout.bins, s);
  for (const [pi, plate] of plan.plates.entries()) {
  const jobs = plate.parts.map((p) => {
    const bin = layout.bins.find((b) => b.id === p.binId);
    return { modelId: modelIdFor(bin.type), params: binParams(bin, s), name: `${p.num}-${fileStem(bin)}`, x: p.x, y: p.y, turned: p.turned };
  });
  const built = buildPlate(jobs, s.bedY, `plate ${pi + 1}`);
  let ok = built.plate.length > 1000;
  plate.parts.forEach((p, i) => {
    const [x0, y0, z0, x1, y1] = built.bounds[i];
    const want = [p.x, s.bedY - p.y - p.h, p.x + p.w, s.bedY - p.y];
    const err = Math.max(...[x0, y0, x1, y1].map((v, k) => Math.abs(v - want[k])));
    if (err > 0.05 || Math.abs(z0) > 1e-6) { ok = false; log(`FAIL plate part ${p.num}: off by ${err.toFixed(3)} mm`); }
  });
  const lids = layout.bins.filter((b) => plate.parts.some((p) => p.binId === b.id) && b.type !== "no-lid" && b.type !== "solid").length;
  if (built.extras.length !== lids) { ok = false; log(`FAIL expected ${lids} lid files, got ${built.extras.length}`); }
  if (!ok) failures++;
  log(`${ok ? "ok  " : "FAIL"} plate ${pi + 1} of ${plan.plates.length}: ${plate.parts.length} bodies placed as planned, ${built.extras.length} lid file(s), 3MF ${(built.plate.length / 1024).toFixed(0)} KiB`);
  await collect();
  }
}

await collect();
log(failures ? `${failures} failure(s)` : `all parts built in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
process.exit(failures ? 1 : 0);
