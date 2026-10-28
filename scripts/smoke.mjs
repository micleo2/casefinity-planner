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

// The free space sizing.ts promises must really be empty in casefinity's bin,
// and 0.4 mm more in any direction must hit a wall, boss or the floor.
{
  const { insideWidth, insideHeight } = await import("../src/sizing.ts");
  for (const [ux, uy, wall] of [[3, 5, 1.2], [2, 4, 3]]) {
    const ss = { ...s, wallThick: wall };
    const bin = { ...newBin(0, 0, ux, uy), pullTab: false };
    const [{ shape: body }] = buildParts(modelIdFor("no-lid"), binParams(bin, ss));
    const boss = ss.wallThick < 2 * ss.wallBump ? ss.wallBump : 0;
    const ix = insideWidth(ux, ss), iy = insideWidth(uy, ss), iz = insideHeight(ss);
    const probe = (gx, gy, gz) =>
      replicad.drawRectangle(ix + gx, iy + gy).translate(-boss / 2, boss / 2)
        .sketchOnPlane("XY", ss.floorThick - gz).extrude(iz + gz - 0.01);
    const overlap = (p) => replicad.measureVolume(body.intersect(p));
    const free = overlap(probe(-0.02, -0.02, -0.01));
    const label = `${ux}×${uy} bin, ${wall} mm walls`;
    const ok = free < 0.01 && overlap(probe(0.4, -0.02, -0.01)) > 0.01 &&
      overlap(probe(-0.02, 0.4, -0.01)) > 0.01 && overlap(probe(-0.02, -0.02, 0.2)) > 0.01;
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${label}: inside ${ix.toFixed(1)} × ${iy.toFixed(1)} × ${iz} mm is free (overlap ${free.toFixed(3)} mm³) and tight`);
    body.delete();
  }
}

console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
