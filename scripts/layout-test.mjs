// Node tests for the pure layout logic (placement, checks, persistence, part
// grouping). No CAD kernel needed. Uses Node's native TypeScript type stripping.
import assert from "node:assert/strict";
import { test } from "node:test";

const { newBin, DEFAULT_SETTINGS } = await import("../src/bins.ts");
const { canPlace, emptyLayout, exportName, firstFreeSpot, parseLayout, runChecks, serializeLayout, slidingGroups } = await import("../src/layout.ts");
const { groupParts } = await import("../src/export.ts");
const { newItem } = await import("../src/sizing.ts");

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
  assert.equal(canPlace(l, { col: 2, row: 0, unitsX: 2, unitsY: 2 }), true);
  assert.equal(canPlace(l, { col: 1, row: 1, unitsX: 2, unitsY: 2 }), false);
  assert.equal(canPlace(l, { col: 3, row: 3, unitsX: 2, unitsY: 1 }), false);
  assert.equal(canPlace(l, { col: -1, row: 0, unitsX: 1, unitsY: 1 }), false);
  // the bin being edited doesn't collide with itself
  assert.equal(canPlace(l, { col: 0, row: 0, unitsX: 3, unitsY: 2 }, l.bins[0].id), true);
});

test("full rows are transport-safe", () => {
  // 4×4: two full-width rows of bins
  const l = layoutWith(4, 4, [[0, 0, 2, 2], [2, 0, 2, 2], [0, 2, 4, 2]]);
  const c = levels(l);
  assert.ok(c.some((t) => t.startsWith("ok: Transport-safe")), c.join("\n"));
  assert.ok(c.includes("ok: All grid units filled."));
});

test("full columns next to empty ones can slide into them", () => {
  // the old full-or-empty-columns rule called this safe; both bins can shift right
  const l = layoutWith(4, 4, [[0, 0, 1, 4], [1, 0, 1, 4]]);
  const checks = runChecks(l);
  const fail = checks.find((c) => c.level === "fail");
  assert.match(fail.text, /can slide right/);
  assert.ok(checks.some((c) => c.level === "info" && c.text.startsWith("8 of 16")));
});

test("a pinwheel around a hole is locked, though no row or column is full", () => {
  // 3×3 with the centre empty: each bin's way into the hole is blocked by the next
  const l = layoutWith(3, 3, [[0, 0, 2, 1], [2, 0, 1, 2], [1, 2, 2, 1], [0, 1, 1, 2]]);
  assert.deepEqual(slidingGroups(l), []);
  const checks = runChecks(l);
  assert.ok(!checks.some((c) => c.level === "fail"), checks.map((c) => c.text).join("\n"));
  assert.ok(checks.some((c) => c.level === "info" && c.text === "1 of 9 grid units empty."));
});

test("sliding names the smallest group that can move, and which way", () => {
  // a row of three with the right-hand cell empty: the middle bin alone can slide right
  const l = layoutWith(3, 1, [[0, 0, 1, 1], [1, 0, 1, 1]]);
  l.bins[0].title = "A";
  l.bins[1].title = "B";
  const groups = slidingGroups(l);
  assert.deepEqual(groups.map((g) => [g.dir, g.bins.map((b) => b.title)]), [["right", ["B"]]]);
  assert.match(runChecks(l).find((c) => c.level === "fail").text, /B \(1×1\) can slide right/);
  // a bin pushing its neighbour: the pair is the group
  const pair = layoutWith(4, 1, [[0, 0, 1, 1], [1, 0, 1, 1]]);
  const right = slidingGroups(pair).filter((g) => g.dir === "right");
  assert.deepEqual(right.map((g) => g.bins.length), [1]);
});

test("print bed check", () => {
  const l = layoutWith(20, 20, [[0, 0, 18, 2], [0, 2, 11, 2]]);
  l.settings.bedX = l.settings.bedY = 256;
  const checks = runChecks(l);
  // 18×15 = 270 mm doesn't fit a 256 bed; 11×15 + 1.3 = 166 mm does
  assert.ok(checks.some((c) => c.level === "fail" && c.text.includes("18×2")));
  assert.ok(!checks.some((c) => c.text.startsWith("Doesn't fit the print bed") && c.text.includes("11×2")));
});

test("switched-off items survive a round trip, and their bins are flagged", () => {
  const l = layoutWith(6, 6, [[0, 0, 2, 2]]);
  const it = { ...newItem("box"), id: "offitem", name: "Spare", off: true };
  l.items = [it];
  l.bins[0].itemId = it.id;
  l.bins[0].title = "Spare";
  const back = parseLayout(serializeLayout(l));
  assert.equal(back.items[0].off, true);
  assert.equal(parseLayout(JSON.stringify({ version: 1, bins: [], items: [{ id: "abc", shape: "box" }] })).items[0].off, false);
  assert.ok(runChecks(back).some((c) => c.level === "warn" && c.text.includes("switched off: Spare (2×2)")));
});

test("first free spot: back row first, left to right, turning the bin if that's what fits", () => {
  const l = layoutWith(6, 4, [[0, 0, 4, 2]]);
  assert.deepEqual(firstFreeSpot(l, 2, 2), { col: 4, row: 0, unitsX: 2, unitsY: 2 });
  // 1×4 doesn't fit upright next to the 4×2 (only 4 rows, 2 taken)… but 4×1 lying does, below it
  assert.deepEqual(firstFreeSpot(l, 1, 4), { col: 4, row: 0, unitsX: 1, unitsY: 4 });
  assert.deepEqual(firstFreeSpot(l, 6, 2), { col: 0, row: 2, unitsX: 6, unitsY: 2 });
  assert.equal(firstFreeSpot(l, 5, 3), null);
});

test("bins left outside after shrinking the area fail", () => {
  const l = layoutWith(6, 6, [[4, 4, 2, 2]]);
  l.settings.areaX = 5;
  assert.ok(runChecks(l).some((c) => c.level === "fail" && c.text.includes("extend past the area")));
});

test("the project name names the exports, and survives a round trip", () => {
  const l = emptyLayout();
  assert.equal(exportName(l, "plates.zip"), "casefinity-plates.zip");
  l.name = "  Soldering kit / v2 ";
  assert.equal(exportName(l, "plates.zip"), "Soldering-kit-v2-plates.zip");
  assert.equal(parseLayout(serializeLayout(l)).name, "Soldering kit / v2");
  assert.equal(parseLayout(JSON.stringify({ version: 1, bins: [] })).name, "");
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
    bins: [{ id: "<script>", unitsX: 0, type: "rocket", pullTab: "yes", height: -3 }],
  }));
  assert.equal(dirty.settings.areaX, DEFAULT_SETTINGS.areaX);
  assert.equal(dirty.settings.gridSpacing, 20);
  assert.equal(dirty.bins[0].unitsX, 1);
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

test("cavity size in grid units uses casefinity's perimeter formula", async () => {
  const { cavityUnits } = await import("../src/bins.ts");
  const s = DEFAULT_SETTINGS;
  // Apache 3800: 377.825 × 268.2875 mm → 25 − 4, 17 − 3
  assert.equal(cavityUnits(377.825, s.gridSpacing, s.sideBorderUnits), 21);
  assert.equal(cavityUnits(268.2875, s.gridSpacing, s.frontBorderUnits), 14);
  // Apache 4800: 454.025 × 323.85 mm → 30 − 4, 21 − 3
  assert.equal(cavityUnits(454.025, s.gridSpacing, s.sideBorderUnits), 26);
  assert.equal(cavityUnits(323.85, s.gridSpacing, s.frontBorderUnits), 18);
  // spec §7 worked example: 350 × 250 → 19 × 13
  assert.equal(cavityUnits(350, 15, 4), 19);
  assert.equal(cavityUnits(250, 15, 3), 13);
});

test("default case is casefinity's default perimeter (350 × 250 → 19 × 13)", async () => {
  const { cavityUnits } = await import("../src/bins.ts");
  const { perimeter } = await import("../src/vendor/casefinity/models/perimeter.ts");
  const d = Object.fromEntries(perimeter.params.map((p) => [p.key, p.default]));
  const s = DEFAULT_SETTINGS;
  assert.equal(s.caseLength, d.overallLength);
  assert.equal(s.caseWidth, d.overallWidth);
  assert.equal(s.sideBorderUnits, d.sideBoarderBinAdd);
  assert.equal(s.frontBorderUnits, d.frontBoarderBinAdd);
  assert.equal(s.gridSpacing, d.gridSpacing);
  assert.equal(cavityUnits(s.caseLength, s.gridSpacing, s.sideBorderUnits), s.areaX);
  assert.equal(cavityUnits(s.caseWidth, s.gridSpacing, s.frontBorderUnits), s.areaY);
});

test("layouts saved before the grid-unit rename still load", () => {
  const old = parseLayout(JSON.stringify({
    version: 1,
    settings: { areaX: 21, areaY: 14, sideBorderModules: 5 },
    bins: [{ id: "abc", col: 2, row: 3, modulesX: 4, modulesY: 6 }],
  }));
  assert.equal(old.bins[0].unitsX, 4);
  assert.equal(old.bins[0].unitsY, 6);
  assert.equal(old.settings.sideBorderUnits, 5);
  assert.equal(old.settings.areaX, 21);
});

test("double-sided bins wider than deep fail; deeper than wide only warn", () => {
  const l = layoutWith(10, 10, [[0, 0, 3, 2], [3, 0, 2, 5], [5, 0, 4, 4]]);
  for (const b of l.bins) b.type = "double-sided";
  const checks = runChecks(l);
  const fail = checks.find((c) => c.level === "fail" && c.text.startsWith("Double-sided"));
  assert.ok(fail, "3×2 fails");
  assert.match(fail.text, /3×2/);
  assert.doesNotMatch(fail.text, /2×5|4×4/);
  assert.ok(checks.some((c) => c.level === "warn" && c.text.includes("2×5")));
});
