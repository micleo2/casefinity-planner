// Node tests for item sizing (src/sizing.ts) and auto-pack (src/pack.ts).
// Pure logic, no CAD kernel. Uses Node's native TypeScript type stripping.
import assert from "node:assert/strict";
import { test } from "node:test";

const { DEFAULT_SETTINGS, newBin } = await import("../src/bins.ts");
const { insideWidth, insideHeight, newItem, placeInBin, sizeItem, unitsFor } = await import("../src/sizing.ts");
const { autoPack } = await import("../src/pack.ts");
const { emptyLayout, runChecks } = await import("../src/layout.ts");

const s = DEFAULT_SETTINGS;
const box = (name, length, width, height, extra = {}) => ({ ...newItem("box"), name, length, width, height, ...extra });
const cyl = (name, diameter, height, extra = {}) => ({ ...newItem("cylinder"), name, diameter, height, ...extra });
const size = (item) => {
  const r = sizeItem(item, s);
  assert.ok(r.ok, r.error);
  return r;
};
const area = (r) => r.unitsX * r.unitsY;
const sorted = (r) => [r.unitsX, r.unitsY].sort((a, b) => a - b);

test("inside dimensions follow casefinity's walls, clearance and socket bosses", () => {
  // 15n − 0.2 clearance − 2.4 walls − 1.5 bosses
  assert.equal(insideWidth(5, s).toFixed(1), "70.9");
  assert.equal(insideWidth(13, s).toFixed(1), "190.9");
  assert.equal(insideHeight(s), 109);
  assert.equal(unitsFor(71, s), 6); // 5 grid units give 70.9: just short
  assert.equal(unitsFor(70.9, s), 5);
  // a wall at least 2 × rib depth needs no boss
  assert.equal(insideWidth(5, { ...s, wallThick: 3 }).toFixed(1), "68.8");
});

test("box sizing: auto picks the smallest bin, as-entered keeps height up", () => {
  const multimeter = box("Multimeter", 182, 88, 52);
  assert.deepEqual(sorted(size(multimeter)), [4, 13]); // on its side: 182 × 52
  assert.deepEqual(sorted(size({ ...multimeter, orient: "as-entered" })), [7, 13]);
  assert.deepEqual(sorted(size(box("Tape", 70, 70, 40))), [4, 6]); // on edge; 40 + 1 misses 3 units by 0.1
  assert.deepEqual(sorted(size(box("Bits", 80, 45, 30))), [3, 4]); // on end, 80 tall
  const bits = size(box("Bits", 80, 45, 30));
  assert.equal(bits.pose.label, "on end");
  assert.match(bits.explain[1] + bits.explain[2], /✓/);
});

test("cylinder sizing: standing or lying, whichever is smaller", () => {
  const leads = cyl("Test leads", 95, 30);
  assert.deepEqual(sorted(size(leads)), [3, 7]); // on its side, 95 tall
  assert.deepEqual(sorted(size({ ...leads, orient: "standing" })), [7, 7]);
  const can = cyl("Can", 66, 160); // too tall to stand: lies down
  assert.equal(size(can).pose.label, "lying on its side");
  const err = sizeItem(cyl("Barrel", 120, 200), s);
  assert.equal(err.ok, false);
  assert.match(err.error, /Too tall/);
});

test("quantities are laid out in a grid and the bin covers them all", () => {
  const two = size(box("Battery", 95, 55, 75, { qty: 2 }));
  assert.equal(two.pose.nx * two.pose.ny >= 2, true);
  assert.ok(area(two) <= 56, `area ${area(two)}`); // never worse than 8 × 7 side by side
  const six = size(cyl("Spool", 56, 50, { qty: 6 }));
  assert.equal(six.pose.nx * six.pose.ny >= 6, true);
});

test("placeInBin puts every copy inside the bin's free space", () => {
  for (const item of [box("Battery", 95, 55, 75, { qty: 2 }), cyl("Leads", 95, 30), box("Tub", 65, 50, 100)]) {
    const r = size(item);
    const bin = newBin(0, 0, r.unitsX, r.unitsY);
    const solids = placeInBin(item, r, bin, s);
    assert.equal(solids.length, item.qty);
    const b = s.wallBump;
    const x0 = -(r.unitsX * 15 - 0.2) / 2 + s.wallThick, x1 = (r.unitsX * 15 - 0.2) / 2 - s.wallThick - b;
    const y0 = -(r.unitsY * 15 - 0.2) / 2 + s.wallThick + b, y1 = (r.unitsY * 15 - 0.2) / 2 - s.wallThick;
    for (const so of solids) {
      const [hx, hy, hz] = so.kind === "box" ? [so.sx / 2, so.sy / 2, so.sz / 2]
        : so.axis === "z" ? [so.r, so.r, so.len / 2] : so.axis === "x" ? [so.len / 2, so.r, so.r] : [so.r, so.len / 2, so.r];
      assert.ok(so.cx - hx >= x0 - 1e-6 && so.cx + hx <= x1 + 1e-6, `${item.name} x`);
      assert.ok(so.cy - hy >= y0 - 1e-6 && so.cy + hy <= y1 + 1e-6, `${item.name} y`);
      assert.ok(so.cz - hz >= s.floorThick - 1e-6 && so.cz + hz <= s.overallHeight + 1e-6, `${item.name} z`);
    }
    // turned bins still hold it; a bin one unit too small doesn't
    assert.ok(placeInBin(item, r, newBin(0, 0, r.unitsY, r.unitsX), s));
    assert.equal(placeInBin(item, r, newBin(0, 0, Math.min(r.unitsX, r.unitsY) - 1 || 1, 1), s), null);
  }
});

// ---- auto-pack ---------------------------------------------------------------

const bed = (ux, uy) => {
  const mm = (n) => n * 15 + 1.3;
  return (mm(ux) <= 256 && mm(uy) <= 256);
};

function assertValid(option, W, H, demands) {
  const grid = Array.from({ length: H }, () => Array(W).fill(0));
  for (const b of option.bins) {
    assert.ok(b.col >= 0 && b.row >= 0 && b.col + b.unitsX <= W && b.row + b.unitsY <= H, "inside the area");
    assert.ok(bed(b.unitsX, b.unitsY), `bin ${b.unitsX}×${b.unitsY} fits the bed`);
    for (let r = b.row; r < b.row + b.unitsY; r++) for (let c = b.col; c < b.col + b.unitsX; c++) grid[r][c]++;
  }
  assert.ok(grid.flat().every((n) => n === 1), "every grid unit covered exactly once");
  for (const d of demands) {
    const mine = option.bins.filter((b) => b.id === d.id);
    assert.equal(mine.length, 1, `${d.id} placed once`);
    const [b] = mine;
    const fits = (b.unitsX >= d.unitsX && b.unitsY >= d.unitsY) || (b.unitsX >= d.unitsY && b.unitsY >= d.unitsX);
    assert.ok(fits, `${d.id} bin big enough`);
  }
}

const mockup = [
  { id: "multimeter", unitsX: 13, unitsY: 7 }, { id: "batteries", unitsX: 8, unitsY: 7 },
  { id: "leads", unitsX: 7, unitsY: 7 }, { id: "bits", unitsX: 6, unitsY: 4 },
  { id: "tape", unitsX: 6, unitsY: 6 }, { id: "zip", unitsX: 5, unitsY: 4 },
];

test("auto-pack fills an Apache 3800 (21 × 14) with the mockup's items", () => {
  const { options, unplaceable } = autoPack(21, 14, mockup, bed);
  assert.deepEqual(unplaceable, []);
  assert.ok(options.length >= 2);
  assert.ok(options.some((o) => o.rule === "columns") && options.some((o) => o.rule === "rows"));
  for (const o of options) assertValid(o, 21, 14, mockup);
  // sorted best first
  for (let i = 1; i < options.length; i++) assert.ok(options[i - 1].score <= options[i].score);
});

test("auto-pack is deterministic for a seed", () => {
  const a = autoPack(21, 14, mockup, bed, { seed: 5 });
  const b = autoPack(21, 14, mockup, bed, { seed: 5 });
  assert.deepEqual(a, b);
});

test("spacer mode fills spare space with spacers, not grown bins", () => {
  const { options } = autoPack(21, 14, mockup, bed, { growth: "spacers" });
  for (const o of options) {
    assertValid(o, 21, 14, mockup);
    assert.equal(o.grown, 0);
    assert.ok(o.spacers > 0);
  }
});

test("growth never makes a bin too big for the bed", () => {
  // one small item in a big area: growth must stop at the bed limit, the rest are spacers
  const { options } = autoPack(30, 20, [{ id: "a", unitsX: 2, unitsY: 2 }], bed);
  for (const o of options) assertValid(o, 30, 20, [{ id: "a", unitsX: 2, unitsY: 2 }]);
});

test("too-big items are reported, not silently dropped", () => {
  const r = autoPack(10, 10, [{ id: "huge", unitsX: 11, unitsY: 3 }], bed);
  assert.deepEqual(r.unplaceable, ["huge"]);
  assert.equal(r.options.length, 0);
});

test("too many items: the closest layouts, listing what they leave out", () => {
  // 30 × 4×4 bins in a 10×10 area: at most 4 fit (two strips of two)
  const crowd = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, unitsX: 4, unitsY: 4 }));
  const r = autoPack(10, 10, crowd, bed);
  assert.equal(r.partial, true);
  assert.deepEqual(r.unplaceable, []);
  assert.ok(r.options.length > 0);
  for (const o of r.options) {
    const placed = crowd.filter((d) => !o.left.includes(d.id));
    assertValid(o, 10, 10, placed);
    assert.equal(placed.length + o.left.length, 30, "every item placed or listed");
    assert.equal(placed.length, 4);
  }
});

test("left out: one big item rather than several small ones", () => {
  // 21×14 case: the multimeter mockup plus a 13×7 duplicate can't all fit
  const extra = [...mockup, { id: "spare", unitsX: 13, unitsY: 7 }];
  const r = autoPack(21, 14, extra, bed);
  assert.equal(r.partial, true);
  const [best] = r.options;
  assert.equal(best.left.length, 1, `left out: ${best.left.join(", ")}`);
  assertValid(best, 21, 14, extra.filter((d) => !best.left.includes(d.id)));
});

test("a full fit isn't partial and leaves nothing out", () => {
  const r = autoPack(21, 14, mockup, bed);
  assert.equal(r.partial, false);
  for (const o of r.options) assert.deepEqual(o.left, []);
});

test("a packed layout passes the checks panel", () => {
  const items = [box("Multimeter", 182, 88, 52), box("Bits", 80, 45, 30), cyl("Leads", 95, 30)];
  const layout = emptyLayout();
  layout.settings.areaX = 21;
  layout.settings.areaY = 14;
  layout.items = items;
  const demands = items.map((it) => {
    const r = size(it);
    return { id: it.id, unitsX: r.unitsX, unitsY: r.unitsY };
  });
  const [best] = autoPack(21, 14, demands, bed).options;
  layout.bins = best.bins.map((p) => ({ ...newBin(p.col, p.row, p.unitsX, p.unitsY), itemId: p.id }));
  const checks = runChecks(layout);
  const bad = checks.filter((c) => c.level === "fail");
  assert.deepEqual(bad, []);
  assert.ok(checks.some((c) => c.text.startsWith("Transport-safe")));
  assert.ok(checks.some((c) => c.text === "All grid units filled."));
  assert.ok(!checks.some((c) => c.text.startsWith("Not in the layout")));
});
