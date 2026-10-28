// Node tests for the pure layout logic (placement, checks, persistence, part
// grouping). No CAD kernel needed. Uses Node's native TypeScript type stripping.
import assert from "node:assert/strict";
import { test } from "node:test";

const { newBin, DEFAULT_SETTINGS } = await import("../src/bins.ts");
const { canPlace, emptyLayout, parseLayout, runChecks, serializeLayout } = await import("../src/layout.ts");
const { groupParts } = await import("../src/export.ts");

function layoutWith(areaX, areaY, rects) {
  const l = emptyLayout();
  l.settings.areaX = areaX;
  l.settings.areaY = areaY;
  l.bins = rects.map(([c, r, x, y]) => newBin(c, r, x, y));
  return l;
}
const levels = (l) => runChecks(l).map((c) => `${c.level}: ${c.text.split(":")[0]}`);

test("placement rejects overlaps and out-of-area rects", () => {
  const l = layoutWith(4, 4, [[0, 0, 2, 2]]);
  assert.equal(canPlace(l, { col: 2, row: 0, modulesX: 2, modulesY: 2 }), true);
  assert.equal(canPlace(l, { col: 1, row: 1, modulesX: 2, modulesY: 2 }), false);
  assert.equal(canPlace(l, { col: 3, row: 3, modulesX: 2, modulesY: 1 }), false);
  assert.equal(canPlace(l, { col: -1, row: 0, modulesX: 1, modulesY: 1 }), false);
  // the bin being edited doesn't collide with itself
  assert.equal(canPlace(l, { col: 0, row: 0, modulesX: 3, modulesY: 2 }, l.bins[0].id), true);
});

test("full rows are transport-safe", () => {
  // 4×4: two full-width rows of bins
  const l = layoutWith(4, 4, [[0, 0, 2, 2], [2, 0, 2, 2], [0, 2, 4, 2]]);
  const c = levels(l);
  assert.ok(c.some((t) => t.startsWith("ok: Transport-safe")), c.join("\n"));
  assert.ok(c.includes("ok: All modules filled."));
});

test("full columns are transport-safe even with partial rows", () => {
  const l = layoutWith(4, 4, [[0, 0, 1, 4], [1, 0, 1, 4]]);
  const checks = runChecks(l);
  assert.ok(checks.some((c) => c.level === "ok" && c.text.includes("no partial columns")));
  assert.ok(checks.some((c) => c.level === "warn" && c.text.startsWith("8 of 16")));
});

test("partial rows and columns fail and are listed 1-based", () => {
  const l = layoutWith(4, 4, [[0, 0, 2, 2]]);
  const fail = runChecks(l).find((c) => c.level === "fail");
  assert.match(fail.text, /rows \(1, 2\) and columns \(1, 2\)/);
});

test("print bed and warp checks", () => {
  const l = layoutWith(20, 20, [[0, 0, 18, 2], [0, 2, 11, 2]]);
  l.settings.bedX = l.settings.bedY = 256;
  const checks = runChecks(l);
  // 18×15 = 270 mm doesn't fit a 256 bed; 11×15 + 1.3 = 166 mm warns
  assert.ok(checks.some((c) => c.level === "fail" && c.text.includes("18×2")));
  assert.ok(checks.some((c) => c.level === "warn" && c.text.includes("11×2")));
});

test("bins left outside after shrinking the area fail", () => {
  const l = layoutWith(6, 6, [[4, 4, 2, 2]]);
  l.settings.areaX = 5;
  assert.ok(runChecks(l).some((c) => c.level === "fail" && c.text.includes("extend past the area")));
});

test("serialize/parse round-trips and sanitizes", () => {
  const l = layoutWith(5, 5, [[0, 0, 2, 3]]);
  l.bins[0].title = "Bits";
  l.bins[0].type = "with-lid";
  l.bins[0].height = 80;
  const back = parseLayout(serializeLayout(l));
  assert.deepEqual(back, l);

  const dirty = parseLayout(JSON.stringify({
    version: 1,
    settings: { areaX: "lots", gridSpacing: 20 },
    bins: [{ id: "<script>", modulesX: 0, type: "rocket", pullTab: "yes", height: -3 }],
  }));
  assert.equal(dirty.settings.areaX, DEFAULT_SETTINGS.areaX);
  assert.equal(dirty.settings.gridSpacing, 20);
  assert.equal(dirty.bins[0].modulesX, 1);
  assert.equal(dirty.bins[0].type, "no-lid");
  assert.equal(dirty.bins[0].pullTab, true);
  assert.equal(dirty.bins[0].height, null);
  assert.match(dirty.bins[0].id, /^[a-z0-9]+$/);
  assert.throws(() => parseLayout("{}"), /Not a Casefinity Planner layout/);
});

test("identical bins are grouped into one part with a count", () => {
  const l = layoutWith(10, 10, [[0, 0, 2, 2], [2, 0, 2, 2], [4, 0, 2, 2], [6, 0, 3, 2]]);
  l.bins[2].height = 80; // same stem, different part
  const groups = groupParts(l);
  assert.deepEqual(
    groups.map((g) => [g.stem, g.count]),
    [["02x02_no-lid", 2], ["02x02_no-lid_v2", 1], ["03x02_no-lid", 1]],
  );
});

test("case presets match casefinity's perimeter presets", async () => {
  const { CASE_PRESETS } = await import("../src/bins.ts");
  const { perimeter } = await import("../src/vendor/casefinity/models/perimeter.ts");
  assert.deepEqual(
    CASE_PRESETS.map((p) => ({ label: p.label, values: { overallLength: p.length, overallWidth: p.width, overallHeight: p.depth } })),
    perimeter.presets,
  );
});

test("cavity modules use casefinity's perimeter formula", async () => {
  const { cavityModules } = await import("../src/bins.ts");
  const s = DEFAULT_SETTINGS;
  // Apache 3800: 377.825 × 268.2875 mm → 25 − 4, 17 − 3
  assert.equal(cavityModules(377.825, s.gridSpacing, s.sideBorderModules), 21);
  assert.equal(cavityModules(268.2875, s.gridSpacing, s.frontBorderModules), 14);
  // Apache 4800: 454.025 × 323.85 mm → 30 − 4, 21 − 3
  assert.equal(cavityModules(454.025, s.gridSpacing, s.sideBorderModules), 26);
  assert.equal(cavityModules(323.85, s.gridSpacing, s.frontBorderModules), 18);
  // spec §7 worked example: 350 × 250 → 19 × 13
  assert.equal(cavityModules(350, 15, 4), 19);
  assert.equal(cavityModules(250, 15, 3), 13);
});
