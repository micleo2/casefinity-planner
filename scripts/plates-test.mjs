// Node tests for the print plan (src/plates.ts): case-map numbering and bed packing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const { DEFAULT_SETTINGS, newBin } = await import("../src/bins.ts");
const { parseLayout } = await import("../src/layout.ts");
const { binNumbers, partFootprint, planPlates } = await import("../src/plates.ts");

const s = DEFAULT_SETTINGS;
const reference = parseLayout(readFileSync(new URL("./reference-layout.json", import.meta.url), "utf8"));

function assertPlan(bins, settings, plan, { margin = 5, gap = 5 } = {}) {
  const seen = new Map();
  for (const [pi, plate] of plan.plates.entries()) {
    for (const p of plate.parts) {
      assert.ok(!seen.has(p.binId), `${p.binId} placed once`);
      seen.set(p.binId, pi);
      const bin = bins.find((b) => b.id === p.binId);
      const [w, h] = partFootprint(bin, settings);
      const [ew, eh] = p.turned ? [h, w] : [w, h];
      assert.ok(Math.abs(p.w - ew) < 1e-6 && Math.abs(p.h - eh) < 1e-6, "footprint, turned if needed");
      assert.ok(p.x >= margin - 1e-9 && p.y >= margin - 1e-9, "inside the margin");
      assert.ok(p.x + p.w <= settings.bedX - margin + 1e-9 && p.y + p.h <= settings.bedY - margin + 1e-9, "on the bed");
    }
    for (const a of plate.parts) for (const b of plate.parts) {
      if (a === b) continue;
      const apart = a.x + a.w + gap <= b.x + 1e-9 || b.x + b.w + gap <= a.x + 1e-9 || a.y + a.h + gap <= b.y + 1e-9 || b.y + b.h + gap <= a.y + 1e-9;
      assert.ok(apart, `parts ${a.num} and ${b.num} keep a ${gap} mm gap`);
    }
  }
  for (const b of bins) assert.ok(seen.has(b.id) || plan.tooBig.includes(b.id), `${b.id} planned`);
}

test("case-map numbers run back row first, left to right", () => {
  const nums = binNumbers(reference.bins);
  const byNum = [...nums.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => reference.bins.find((b) => b.id === id));
  for (let i = 1; i < byNum.length; i++) {
    const [a, b] = [byNum[i - 1], byNum[i]];
    assert.ok(a.row < b.row || (a.row === b.row && a.col < b.col));
  }
  assert.equal(nums.size, reference.bins.length);
});

test("the reference layout's 17 bins fit on 256 mm plates without overlapping", () => {
  const plan = planPlates(reference.bins, reference.settings);
  assert.deepEqual(plan.tooBig, []);
  assertPlan(reference.bins, reference.settings, plan);
  // 17 bins need well under one plate each
  assert.ok(plan.plates.length >= 2 && plan.plates.length <= 8, `${plan.plates.length} plates`);
});

test("a small bed uses more plates; a too-big bin is reported", () => {
  const small = { ...s, bedX: 180, bedY: 180 };
  const bins = [newBin(0, 0, 11, 3), newBin(0, 3, 6, 6), newBin(6, 3, 3, 3), newBin(0, 9, 13, 2)];
  const plan = planPlates(bins, small);
  assert.deepEqual(plan.tooBig, [bins[3].id]); // 13 × 15 + 1.3 = 196.3 mm > 170 usable
  assertPlan(bins, small, plan);
  // the 11 × 3 (166.3 mm) only fits along one axis
  assert.ok(plan.plates.flatMap((p) => p.parts).some((p) => p.binId === bins[0].id));
});

test("parts turn on the bed when that is the only way they fit", () => {
  const tall = { ...s, bedX: 120, bedY: 220 };
  const bins = [newBin(0, 0, 12, 4)]; // 181.3 × 61.3: only fits turned
  const plan = planPlates(bins, tall);
  assert.equal(plan.plates[0].parts[0].turned, true);
  assertPlan(bins, tall, plan);
});
