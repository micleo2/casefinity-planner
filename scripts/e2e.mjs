// End-to-end test in headless Chromium over the DevTools protocol: serves the
// production build, recreates the reference layout (screenshot-ref.jpg) by
// dragging on the grid with real mouse events, exercises move / resize /
// rotate / delete / undo, exports the ZIP and checks its contents.
//
// Usage: npm run build && npm run e2e   (CHROME=/path/to/chromium to override;
//        BASE_PATH=/sub/ for both commands to test a subpath build;
//        E2E_OUT=dir to keep the screenshot and downloads)
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";

const out = process.env.E2E_OUT ?? mkdtempSync(join(tmpdir(), "planner-e2e-"));
const PORT = 4174;
const DEBUG_PORT = 9334;
// Build and test with the same BASE_PATH to check a subpath deploy (GitHub Pages)
const SITE = `http://localhost:${PORT}${process.env.BASE_PATH ?? "/"}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
const chrome = spawn(process.env.CHROME ?? "chromium", [
  "--headless=new", "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
  `--remote-debugging-port=${DEBUG_PORT}`, "--window-size=1400,1600", "about:blank",
], { stdio: "ignore" });
const cleanup = () => { chrome.kill(); server.kill(); };
process.on("exit", cleanup);

async function poll(fn, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await sleep(150);
  }
}

await poll(() => fetch(SITE).then((r) => r.ok));
const targets = await poll(() => fetch(`http://127.0.0.1:${DEBUG_PORT}/json`).then((r) => r.json()));
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? "exception");
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  // confirm() dialogs ("Replace the bins…?") are accepted, as a user would
  if (m.method === "Page.javascriptDialogOpening") { dialogs.push(m.params.message); ws.send(JSON.stringify({ id: ++seq, method: "Page.handleJavaScriptDialog", params: { accept: true } })); }
};
const dialogs = [];
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.result.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description);
  return res.result.result.value;
};
const text = (id) => js(`document.getElementById(${JSON.stringify(id)}).textContent`);

await send("Runtime.enable");
await send("Page.enable");
await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: out });
await send("Page.navigate", { url: SITE });
await poll(() => js(`document.readyState === "complete"`));
await js(`localStorage.clear()`);
await send("Page.reload");
await poll(() => js(`document.body.dataset.kernel === "ready"`));

// --- fresh start: --Custom-- with casefinity's default perimeter ------------------
const area = () => js(`[document.getElementById("areaX").value, document.getElementById("areaY").value].join("×")`);
const presetText = () => js(`(() => { const s = document.getElementById("case-preset"); return s.options[s.selectedIndex].text; })()`);
assert.equal(await presetText(), "--Custom--");
assert.deepEqual(await js(`[...document.getElementById("case-preset").options].map(o => o.text)`), ["--Custom--", "Apache 3800", "Apache 4800"]);
assert.equal(await js(`[document.getElementById("caseLength").value, document.getElementById("caseWidth").value].join("×")`), "350×250");
assert.equal(await area(), "19×13");
console.log("ok   starts on --Custom-- with casefinity defaults: 350 × 250 mm → 19 × 13");
// the reference screenshot is a 15 × 15 grid
await js(`for (const id of ["areaX", "areaY"]) { const i = document.getElementById(id); i.value = "15"; i.dispatchEvent(new Event("input")); i.dispatchEvent(new Event("change")); }`);
assert.equal(await area(), "15×15");

// Cell centre (0-based col,row) in viewport pixels
const cellXY = async (c, r) => js(`(() => {
  const svg = document.getElementById("grid");
  svg.scrollIntoView({ block: "center" });
  const m = svg.getScreenCTM();
  const p = new DOMPoint(26 + (${c} + 0.5) * 32, 26 + (${r} + 0.5) * 32).matrixTransform(m);
  return [p.x, p.y];
})()`);
const mouse = (type, [x, y]) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
async function drag(from, to) {
  await mouse("mousePressed", from);
  await mouse("mouseMoved", [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]);
  await mouse("mouseMoved", to);
  await mouse("mouseReleased", to);
}
const drawBin = async (c, r, w, h) => drag(await cellXY(c, r), await cellXY(c + w - 1, r + h - 1));
const key = async (k, code = k, mods = 0) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, modifiers: mods });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, modifiers: mods });
};
const bins = () => js(`JSON.parse(localStorage.getItem("casefinity-planner/layout")).bins.map(b => [b.col, b.row, b.unitsX, b.unitsY])`);

// --- recreate the reference screenshot's layout (15×15, 17 bins) -------------
const ref = [
  [0, 0, 2, 5], [2, 0, 2, 2], [4, 0, 2, 2], [6, 0, 2, 2], [8, 0, 2, 2], [10, 0, 2, 2], [12, 0, 3, 2],
  [2, 2, 7, 3], [9, 2, 6, 3],
  [0, 5, 2, 6], [2, 5, 6, 5], [8, 5, 3, 5], [11, 5, 4, 3],
  [11, 8, 4, 7], [0, 11, 2, 4], [2, 10, 3, 5], [5, 10, 6, 5],
];
for (const b of ref) await drawBin(...b);
assert.equal((await bins()).length, 17, "all 17 bins drawn");
// a valid layout reports nothing: no passes are listed, and the checks hide
assert.equal(await text("checks"), "");
assert.equal(await js(`document.getElementById("checks").hidden`), true);
console.log("ok   reference layout: 17 bins, all checks pass");

// --- drawing over an existing bin is rejected ---------------------------------
await drawBin(1, 1, 2, 2);
assert.equal((await bins()).length, 17);
console.log("ok   overlapping draw rejected");

// --- select + edit via the bin card ------------------------------------------
await mouse("mousePressed", await cellXY(3, 12));
await mouse("mouseReleased", await cellXY(3, 12));
assert.equal(await text("bin-heading"), "Bin 3×5");
assert.match(await text("bin-dims"), /Footprint 44\.80 × 74\.80 mm · Bounding box 46\.30 × 76\.30 mm/);
await js(`(() => { const t = document.getElementById("bin-title"); t.value = "Small parts"; t.dispatchEvent(new Event("input")); t.dispatchEvent(new Event("change")); })()`);
console.log("ok   select 3×5 and title it");

// --- delete, undo, redo ----------------------------------------------------------
await key("Delete");
assert.equal((await bins()).length, 16);
assert.ok(await js(`[...document.querySelectorAll("#checks .check-line.fail")].some((p) => p.textContent.startsWith("Not transport-safe"))`));
// failures are listed first, then warnings, then notes (the empty grid units)
const rank = { fail: 0, warn: 1, info: 2 };
const levels = await js(`[...document.querySelectorAll("#checks .check-line")].map((p) => p.classList[1])`);
assert.deepEqual(levels, [...levels].sort((x, y) => rank[x] - rank[y]));
assert.ok(levels.includes("fail") && levels.includes("info"), levels.join());
await key("z", "KeyZ", 2);
assert.equal((await bins()).length, 17);
await key("z", "KeyZ", 2 | 8);
assert.equal((await bins()).length, 16);
await key("z", "KeyZ", 2);
console.log("ok   delete / undo / redo");

// --- move, resize, rotate in free space ------------------------------------------
await drag(await cellXY(13, 12), await cellXY(13, 12)); // select the 4×7
await key("Delete");
await drawBin(11, 8, 2, 2);
await drag(await cellXY(11, 8), await cellXY(13, 12)); // move by (+2, +4)
assert.deepEqual((await bins()).at(-1), [13, 12, 2, 2]);
const handle = await js(`(() => { const r = document.querySelector("#grid .handle.left").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
await drag(handle, await cellXY(11, 13)); // left edge to col 11 → 4 wide
assert.deepEqual((await bins()).at(-1), [11, 12, 4, 2]);
await key("r", "KeyR"); // 2×4 would hang off the bottom edge: refused
assert.deepEqual((await bins()).at(-1), [11, 12, 4, 2]);
assert.match(await text("bin-error"), /No room to rotate/);
await key("ArrowUp", "ArrowUp");
assert.deepEqual((await bins()).at(-1), [11, 11, 4, 2]);
await key("r", "KeyR");
assert.deepEqual((await bins()).at(-1), [11, 11, 2, 4]);
console.log("ok   move / resize handle / rotate / arrow-key move");
// put the 4×7 back so the export matches the reference
await key("Delete");
await drawBin(11, 8, 4, 7);
assert.doesNotMatch(await text("checks"), /grid units empty/);

// --- one bin of each other type, for the export -----------------------------------
const setType = async (c, r, type) => {
  await drag(await cellXY(c, r), await cellXY(c, r));
  await js(`(() => { const s = document.getElementById("bin-type"); s.value = "${type}"; s.dispatchEvent(new Event("change")); })()`);
};
await setType(2, 0, "with-lid");
await setType(0, 0, "double-sided"); // 2×5: deeper than wide, which casefinity supports
await setType(0, 12, "solid");
console.log("ok   set lid / double-sided / solid types");

// --- preview renders (WebGL via SwiftShader) --------------------------------------
await js(`document.getElementById("view-bin").click()`);
await poll(() => text("preview-status").then((t) => t.includes("built in")), 60000);
console.log(`ok   preview: ${await text("preview-status")}`);
// deselecting hides the bin card and the Selected-bin option, and falls back to Whole case
await key("Escape");
assert.deepEqual(await js(`["bin-card", "view-seg", "case-view"].map((id) => document.getElementById(id).hidden)`), [true, true, false]);
await mouse("mousePressed", await cellXY(0, 12)); await mouse("mouseReleased", await cellXY(0, 12));
assert.deepEqual(await js(`["bin-card", "view-seg"].map((id) => document.getElementById(id).hidden)`), [false, false]);
console.log("ok   bin card and Selected-bin preview only while a bin is selected");

// --- layout survives a reload; save/load ------------------------------------------
await send("Page.reload");
await poll(() => js(`document.body.dataset.kernel === "ready"`));
assert.equal((await bins()).length, 17);
await js(`document.getElementById("save-layout").click()`);
await poll(() => readdirSync(out).includes("casefinity-layout.json"));
console.log("ok   layout persists across reload; save downloads JSON");

// --- case presets (casefinity perimeter formula) ------------------------------------
const pickPreset = (label) => js(`(() => { const s = document.getElementById("case-preset"); s.value = ${JSON.stringify(label)}; s.dispatchEvent(new Event("change")); })()`);
await pickPreset("Apache 4800");
assert.equal(await area(), "26×18");
await pickPreset("Apache 3800");
assert.equal(await area(), "21×14");
assert.match(await text("case-hint"), /leaving 21 × 14 for bins\. Case depth 110 mm\./);
await js(`(() => { const i = document.getElementById("sideBorderUnits"); i.value = "5"; i.dispatchEvent(new Event("input")); i.dispatchEvent(new Event("change")); })()`);
assert.equal(await area(), "20×14");
// the 15-row reference layout no longer fits 14 rows: kept, but flagged
assert.equal((await bins()).length, 17);
assert.ok(await js(`[...document.querySelectorAll("#checks .check-line.fail")].some((p) => p.textContent.startsWith("4 bin(s) extend past the area"))`));
assert.equal(await presetText(), "Apache 3800");
await pickPreset(""); // --Custom-- restores casefinity's 350 × 250 (border is now 5 / 3)
assert.equal(await area(), "18×13");
assert.equal(await presetText(), "--Custom--");
console.log("ok   Apache 3800 → 21×14, Apache 4800 → 26×18, border units re-apply, --Custom-- restores defaults");

// --- screenshot for review --------------------------------------------------------
await js(`document.getElementById("view-bin").click()`);
await drag(await cellXY(3, 12), await cellXY(3, 12));
await poll(() => text("preview-status").then((t) => t.startsWith("3×5")), 60000);
await sleep(500);
await js(`window.scrollTo(0, 0)`);
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
writeFileSync(join(out, "e2e.png"), Buffer.from(shot.result.data, "base64"));

// --- items → auto-pack → whole-case preview -----------------------------------------
await pickPreset("Apache 3800");
await js(`(() => { const i = document.getElementById("sideBorderUnits"); i.value = "4"; i.dispatchEvent(new Event("input")); i.dispatchEvent(new Event("change")); })()`);
assert.equal(await area(), "21×14");
async function addItem(shape, name, dims, qty = 1, orient = null) {
  await js(`document.getElementById("add-${shape}").click()`);
  await js(`(() => {
    const row = document.querySelector("#item-list .item-row.open");
    const set = (el, v) => { el.value = String(v); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
    set(row.querySelector(".item-editor input[type=text]"), ${JSON.stringify(name)});
    const dims = row.querySelectorAll(".dims input");
    ${JSON.stringify(dims)}.forEach((v, i) => set(dims[i], v));
    set(row.querySelector("input.qty"), ${qty});
    ${orient ? `set(row.querySelectorAll(".item-editor select")[1], ${JSON.stringify(orient)});` : ""}
  })()`);
}
await addItem("box", "Multimeter", [182, 88, 52]);
await addItem("box", "12 V battery", [95, 55, 75], 2);
await addItem("cylinder", "Test leads", [95, 30]);
await addItem("box", "Bit set", [80, 45, 30]);
await addItem("box", "Tape measure", [70, 70, 40]);
await addItem("box", "Zip ties tub", [65, 50, 100], 1, "as-entered");
const chips = await js(`[...document.querySelectorAll("#item-list .bin-chip")].map((e) => e.textContent)`);
assert.deepEqual([chips[0], chips[2], chips[3], chips[4], chips[5]], ["13×4", "3×7", "4×3", "6×4", "5×4"], chips.join(", "));
assert.ok(!chips.includes("—"), chips.join(", "));
// a row opens in place with its sizing explained
await js(`document.querySelector("#item-list .item-row:nth-child(5) .item-head").click()`);
assert.match(await js(`document.querySelector("#item-list .item-row.open").textContent`), /Tape measure[\s\S]*→ 6 grid units/);
assert.match(await text("items-budget"), /Items need \d+ of 294 grid units/);
assert.match(await text("items-height"), /up to 109 mm tall/);
console.log(`ok   items panel: 6 items sized → ${chips.join(", ")}`);

await js(`document.getElementById("autopack-run").click()`);
await poll(() => js(`document.querySelectorAll("#autopack-options .option").length >= 2`));
const optionTitles = await js(`[...document.querySelectorAll("#autopack-options .option strong")].map((e) => e.textContent)`);
assert.ok(optionTitles.some((t) => t.includes("columns")) && optionTitles.some((t) => t.includes("rows")), optionTitles.join(", "));
await js(`document.querySelector("#autopack-options .option button").click()`);
await poll(() => bins().then((b) => b.length > 0 && b.length !== 17));
assert.equal(dialogs.length, 1, "asked before replacing the existing bins");
assert.equal(await text("checks"), "");
const linked = await js(`JSON.parse(localStorage.getItem("casefinity-planner/layout")).bins.filter((b) => b.itemId).length`);
assert.equal(linked, 6);
console.log(`ok   auto-pack: ${optionTitles.length} layouts (${optionTitles.join(" / ")}), applied: ${(await bins()).length} bins, all checks pass`);

// live link: every item on the grid; hovering a row lights its bin; the bin names its item
assert.equal(await text("items-count"), "6 of 6 on the grid");
await js(`document.querySelector("#item-list .item-row:first-child").dispatchEvent(new MouseEvent("mouseenter"))`);
const lit = await js(`[...document.querySelectorAll("#grid .bin.linked")].map((g) => g.dataset.bin)`);
const multimeterBins = await js(`JSON.parse(localStorage.getItem("casefinity-planner/layout")).bins.filter((b) => b.title === "Multimeter").map((b) => b.id)`);
assert.deepEqual(lit, multimeterBins);
await js(`document.querySelector("#item-list .item-row:first-child .item-status button").click()`);
assert.match(await text("bin-item"), /^Holds Multimeter \(182 × 88 × 52 mm\)/);
// + Add bin: remove the multimeter's bin, then put it back from the panel
await key("Delete");
assert.equal(await text("items-count"), "5 of 6 on the grid");
await js(`document.querySelector("#item-list .item-row:first-child .add-bin").click()`);
assert.equal(await text("items-count"), "6 of 6 on the grid");
assert.match(await text("bin-item"), /^Holds Multimeter/);
await key("z", "KeyZ", 2);
await key("z", "KeyZ", 2);
assert.equal(await text("items-count"), "6 of 6 on the grid");
console.log("ok   items ↔ bins: hover highlight, Holds link, + Add bin");

// switching an item off: kept, greyed, its bin flagged, left out of auto-pack
await js(`document.querySelector("#item-list .item-row:nth-child(4) .item-on").click()`);
assert.equal(await text("items-count"), "5 of 5 on the grid · 1 off");
assert.match(await text("checks"), /switched off: Bit set/);
assert.equal(await js(`document.querySelectorAll("#grid .bin.item-off").length`), 1);
assert.match(await text("autopack-summary"), /all 5 items/);
await js(`document.querySelector("#item-list .item-row:nth-child(4) .item-on").click()`);
assert.equal(await text("items-count"), "6 of 6 on the grid");
console.log("ok   switching an item off and on");

// whole-case preview: a WebGL canvas
assert.equal(await js(`document.getElementById("view-case").getAttribute("aria-pressed")`), "true");
await poll(() => js(`!!document.querySelector("#case-view canvas")`), 30000);
console.log("ok   whole-case 3D preview renders");
await sleep(500);
const caseShot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
writeFileSync(join(out, "e2e-case.png"), Buffer.from(caseShot.result.data, "base64"));

await send("Page.reload");
await poll(() => js(`document.body.dataset.kernel === "ready"`));
assert.equal(await js(`JSON.parse(localStorage.getItem("casefinity-planner/layout")).items.length`), 6);
await poll(() => js(`document.querySelectorAll("#item-list .item-row").length === 6`));
const itemsShot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
writeFileSync(join(out, "e2e-items.png"), Buffer.from(itemsShot.result.data, "base64"));
console.log("ok   items survive a reload");

// --- print plan: plates, plate export ----------------------------------------------
await js(`location.hash = "#print"`);
await poll(() => js(`!document.getElementById("print-page").hidden && document.querySelectorAll("#plates .plate-card").length > 0`));
const plateCount = await js(`document.querySelectorAll("#plates .plate-card").length`);
const binCount = (await bins()).length;
const platedParts = await js(`[...document.querySelectorAll("#plates .part-num")].map((t) => +t.textContent).sort((a, b) => a - b)`);
assert.deepEqual(platedParts, Array.from({ length: binCount }, (_, i) => i + 1), "every bin on exactly one plate");
await poll(() => js(`!document.getElementById("export-plates").disabled`));
// the project name names the export
await js(`(() => { const i = document.getElementById("project-name"); i.value = "Test Kit"; i.dispatchEvent(new Event("input")); i.dispatchEvent(new Event("change")); })()`);
await js(`document.getElementById("export-plates").click()`);
await poll(() => text("plates-status").then((t) => /Exported|failed/.test(t)), 240000);
const plateStatus = await text("plates-status");
assert.match(plateStatus, /Exported/, plateStatus);
await poll(() => readdirSync(out).includes("Test-Kit-plates.zip"));
await sleep(500);
const plateZip = unzipSync(readFileSync(join(out, "Test-Kit-plates.zip")));
assert.equal(JSON.parse(strFromU8(unzipSync(readFileSync(join(out, "Test-Kit-plates.zip")))["layout.json"])).name, "Test Kit");
const plateFiles = Object.keys(plateZip).filter((n) => n.startsWith("plates/"));
assert.equal(plateFiles.length, plateCount);
for (const n of plateFiles) {
  const inner = unzipSync(plateZip[n]);
  const model = strFromU8(inner["3D/3dmodel.model"]);
  const objects = (model.match(/<object /g) ?? []).length;
  assert.ok(objects > 0, `${n} has objects`);
}
const objectsTotal = plateFiles.reduce((a, n) => a + (strFromU8(unzipSync(plateZip[n])["3D/3dmodel.model"]).match(/<object /g) ?? []).length, 0);
assert.equal(objectsTotal, binCount, "one 3MF object per bin across the plates");
assert.ok(plateZip["layout.json"] && !plateZip["case-map.svg"]);
console.log(`ok   print plan: ${plateCount} plate(s), ${binCount} parts; ${plateStatus} ZIP: ${plateFiles.length} plate 3MF`);

// selecting bins: the plates follow the ticks
assert.equal(await js(`document.querySelectorAll("#pick-list input:checked").length`), binCount);
await js(`document.getElementById("pick-none").click()`);
assert.equal(await js(`document.querySelectorAll("#plates .plate-card").length`), 0);
assert.ok(await js(`document.getElementById("export-plates").disabled`));
await js(`[...document.querySelectorAll("#pick-list input")].slice(0, 3).forEach((b) => b.click())`);
const picked = await js(`[...document.querySelectorAll("#plates .part-num")].map((t) => +t.textContent).sort((a, b) => a - b)`);
assert.deepEqual(picked, [1, 2, 3], "only the ticked bins, with their own numbers");
await js(`document.getElementById("pick-all").click()`);
assert.equal(await js(`document.querySelectorAll("#plates .part-num").length`), binCount);
console.log("ok   Bins to print: plates follow the selection");

await js(`window.scrollTo(0, 0)`);
const printShot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
writeFileSync(join(out, "e2e-print.png"), Buffer.from(printShot.result.data, "base64"));

assert.deepEqual(errors, [], `page errors:\n${errors.join("\n")}`);
console.log(`\nall e2e checks passed — artifacts in ${out}`);
ws.close();
process.exit(0);
