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
await collect();
log(failures ? `${failures} failure(s)` : `all parts built in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
process.exit(failures ? 1 : 0);
