// Node smoke test: builds planner bins through the same mapping + vendored
// casefinity code the browser uses, with the real OCCT kernel, and checks the
// bounding boxes against the spec formulas (F(n) = n·P − 2c, ribs b proud on
// −X/+Y, pull tab on top). Uses Node's native TypeScript type stripping.
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";

// emscripten's loader expects CJS globals under Node
const require = createRequire(import.meta.url);
globalThis.require = require;
globalThis.__dirname = dirname(require.resolve("replicad-opencascadejs/src/replicad_single.js"));

const { default: initOpenCascade } = await import("replicad-opencascadejs/src/replicad_single.js");
const replicad = await import("replicad");
replicad.setOC(await initOpenCascade());
const font = readFileSync(new URL("../public/LiberationSans-Regular.ttf", import.meta.url));
await replicad.loadFont(font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength), "LiberationSans");

const { DEFAULT_SETTINGS, newBin, binParams, modelIdFor, boundingBox, buildHeight, fileStem } =
  await import("../src/bins.ts");
const { buildParts, stlBlob } = await import("../src/vendor/casefinity/exports.ts");
const { stepBytes } = await import("../src/step.ts");

const s = DEFAULT_SETTINGS;
let failures = 0;

function check(label, actual, expected, tol = 0.02) {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${actual.toFixed(2)} (expected ${expected.toFixed(2)})`);
}

const cases = [
  { mx: 2, my: 3, type: "no-lid", pullTab: true },
  { mx: 3, my: 5, type: "no-lid", pullTab: false },
  { mx: 2, my: 2, type: "with-lid", pullTab: true, lidLabel: "M3" },
  { mx: 3, my: 3, type: "double-sided", pullTab: true },
  { mx: 1, my: 2, type: "solid", pullTab: true },
];

for (const c of cases) {
  const bin = { ...newBin(0, 0, c.mx, c.my), type: c.type, pullTab: c.pullTab, lidLabel: c.lidLabel ?? "" };
  const t0 = performance.now();
  const parts = buildParts(modelIdFor(bin.type), binParams(bin, s));
  const ms = performance.now() - t0;
  console.log(`\n${fileStem(bin)}: ${parts.length} part(s), built in ${ms.toFixed(0)} ms`);

  // The body is the first part; lids (if any) are laid out beside it.
  const [lo, hi] = parts[0].shape.boundingBox.bounds;
  const [bx, by] = boundingBox(bin, s);
  check("body X", hi[0] - lo[0], bx);
  check("body Y", hi[1] - lo[1], by);
  if (bin.type === "no-lid" || bin.type === "solid") check("body Z", hi[2] - lo[2], buildHeight(bin, s));

  const stl = stlBlob(parts).size;
  const step = stepBytes(parts).length;
  console.log(`     STL ${(stl / 1024).toFixed(0)} KiB, STEP ${(step / 1024).toFixed(0)} KiB`);
  if (!stl || !step) failures++;
  for (const { shape } of parts) shape.delete();
}

console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
