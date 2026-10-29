import "./style.css";
import { wrap } from "comlink";
import type { CadWorkerApi, ExportFormat } from "./worker.ts";
import {
  BIN_TYPES,
  CASE_PRESETS,
  DEFAULT_SETTINGS,
  cavityUnits,
  binParams,
  boundingBox,
  buildHeight,
  footprint,
  modelIdFor,
  newBin,
} from "./bins.ts";
import type { Bin, BinType, Layout, Settings } from "./bins.ts";
import { canPlace, emptyLayout, fitsBed, parseLayout, runChecks, serializeLayout } from "./layout.ts";
import { GridEditor } from "./grid.ts";
import { exportZip, groupParts } from "./export.ts";
import { ItemsPage } from "./itemsPage.ts";
import { AutoPackCard } from "./autopack.ts";
import { PrintPage } from "./printPage.ts";
import { insideHeight, insideVolume, placeInBin, sizeItem, solidVolume } from "./sizing.ts";
import type { Solid } from "./sizing.ts";
import type { CaseView } from "./caseView.ts";
import type { Axis, BinView } from "./binView.ts";

const cad = wrap<CadWorkerApi>(new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }));

const STORAGE_KEY = "casefinity-planner/layout";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number) => n.toFixed(2);
const fmt1 = (n: number) => n.toFixed(1);

// ---- state -------------------------------------------------------------------

function loadStored(): Layout {
  try {
    const json = localStorage.getItem(STORAGE_KEY);
    if (json) return parseLayout(json);
  } catch {
    // unreadable storage or a stale format: start fresh
  }
  return emptyLayout();
}

let layout = loadStored();
let selectedId: string | null = null;
const history: string[] = [serializeLayout(layout)];
let historyIndex = 0;

const selected = (): Bin | undefined => layout.bins.find((b) => b.id === selectedId);

/** Re-render after any change; `commit` also records an undo step. */
function update(commit = false) {
  const json = serializeLayout(layout);
  try {
    localStorage.setItem(STORAGE_KEY, json);
  } catch {
    // private mode etc. — the layout still works, it just won't survive a reload
  }
  if (commit && json !== history[historyIndex]) {
    history.splice(historyIndex + 1);
    history.push(json);
    if (history.length > 200) history.shift();
    historyIndex = history.length - 1;
  }
  render();
}

function restore(index: number) {
  historyIndex = index;
  layout = parseLayout(history[index]);
  if (!selected()) selectedId = null;
  syncSettingInputs();
  syncBinInputs();
  itemsPage.rebuild();
  update();
}

function select(id: string | null) {
  selectedId = id;
  syncBinInputs();
  render();
}

// ---- settings card -------------------------------------------------------------

const settingKeys: (keyof Settings)[] = [
  "areaX", "areaY", "gridSpacing", "overallHeight", "wallThick", "clear",
  "floorThick", "ribWidth", "wallBump", "draftAngle", "pullTabHeight",
  "caseLength", "caseWidth", "sideBorderUnits", "frontBorderUnits", "bedX", "bedY", "bedZ", "itemPlay",
];
const integerSettings = new Set<keyof Settings>(["areaX", "areaY", "sideBorderUnits", "frontBorderUnits"]);
const zeroAllowed = new Set<keyof Settings>(["draftAngle", "sideBorderUnits", "frontBorderUnits", "itemPlay"]);
/** Settings that feed casefinity's perimeter formula: editing one recomputes the area. */
const caseKeys = new Set<keyof Settings>(["caseLength", "caseWidth", "sideBorderUnits", "frontBorderUnits"]);

function syncSettingInputs() {
  for (const key of settingKeys) $<HTMLInputElement>(key).value = String(layout.settings[key]);
  const s = layout.settings;
  presetSelect.value = CASE_PRESETS.find((p) => p.length === s.caseLength && p.width === s.caseWidth)?.label ?? "";
}

for (const key of settingKeys) {
  const input = $<HTMLInputElement>(key);
  input.addEventListener("input", () => {
    let v = input.valueAsNumber;
    if (!Number.isFinite(v) || v < 0 || (v === 0 && !zeroAllowed.has(key))) return;
    if (integerSettings.has(key)) v = Math.min(60, Math.max(zeroAllowed.has(key) ? 0 : 1, Math.round(v)));
    layout.settings[key] = v;
    update();
  });
  input.addEventListener("change", () => {
    if (caseKeys.has(key)) applyCaseSize();
    syncSettingInputs();
    update(true);
  });
}

const presetSelect = $<HTMLSelectElement>("case-preset");
presetSelect.add(new Option("--Custom--", ""));
for (const p of CASE_PRESETS) presetSelect.add(new Option(p.label, p.label));

/** Area in grid units from the case size, with casefinity's perimeter formula. */
function applyCaseSize() {
  const s = layout.settings;
  const x = cavityUnits(s.caseLength, s.gridSpacing, s.sideBorderUnits);
  const y = cavityUnits(s.caseWidth, s.gridSpacing, s.frontBorderUnits);
  if (x >= 1 && y >= 1 && x <= 60 && y <= 60) {
    s.areaX = x;
    s.areaY = y;
  }
}

/** "--Custom--" restores casefinity's own perimeter defaults; a preset fills its case. */
presetSelect.addEventListener("change", () => {
  const preset = CASE_PRESETS.find((p) => p.label === presetSelect.value);
  layout.settings.caseLength = preset?.length ?? DEFAULT_SETTINGS.caseLength;
  layout.settings.caseWidth = preset?.width ?? DEFAULT_SETTINGS.caseWidth;
  applyCaseSize();
  syncSettingInputs();
  update(true);
});

$("reset-advanced").addEventListener("click", () => {
  for (const key of ["floorThick", "ribWidth", "wallBump", "draftAngle", "pullTabHeight"] as const) {
    layout.settings[key] = DEFAULT_SETTINGS[key];
  }
  syncSettingInputs();
  update(true);
});

// ---- bin card ------------------------------------------------------------------

const typeSelect = $<HTMLSelectElement>("bin-type");
for (const t of BIN_TYPES) typeSelect.add(new Option(t.label, t.value));

const binInputs = {
  title: $<HTMLInputElement>("bin-title"),
  mx: $<HTMLInputElement>("bin-mx"),
  my: $<HTMLInputElement>("bin-my"),
  height: $<HTMLInputElement>("bin-height"),
  lidLabel: $<HTMLInputElement>("bin-lid-label"),
  fillet: $<HTMLInputElement>("bin-fillet"),
  pullTab: $<HTMLInputElement>("bin-pulltab"),
};

function syncBinInputs() {
  const bin = selected();
  $("bin-empty").hidden = !!bin;
  $("bin-form").hidden = !bin;
  $("bin-error").hidden = true;
  if (!bin) return;
  binInputs.title.value = bin.title;
  binInputs.mx.value = String(bin.unitsX);
  binInputs.my.value = String(bin.unitsY);
  typeSelect.value = bin.type;
  binInputs.height.value = bin.height === null ? "" : String(bin.height);
  binInputs.lidLabel.value = bin.lidLabel;
  binInputs.fillet.value = String(bin.bottomFillet);
  binInputs.pullTab.checked = bin.pullTab;
}

function binError(text: string | null) {
  const e = $("bin-error");
  e.hidden = !text;
  e.textContent = text ?? "";
}

/** Resize the selected bin from the grid-unit inputs, if there's room. */
function resizeSelected() {
  const bin = selected();
  if (!bin) return;
  const mx = Math.round(binInputs.mx.valueAsNumber);
  const my = Math.round(binInputs.my.valueAsNumber);
  if (!(mx >= 1 && my >= 1)) return;
  const rect = { col: bin.col, row: bin.row, unitsX: mx, unitsY: my };
  if (canPlace(layout, rect, bin.id)) {
    binError(null);
    Object.assign(bin, rect);
    update();
  } else {
    binError(`No room for ${mx}×${my} here — it would overlap another bin or leave the area.`);
  }
}

binInputs.mx.addEventListener("input", resizeSelected);
binInputs.my.addEventListener("input", resizeSelected);
for (const input of [binInputs.mx, binInputs.my]) {
  input.addEventListener("change", () => {
    syncBinInputs();
    update(true);
  });
}

binInputs.title.addEventListener("input", () => {
  const bin = selected();
  if (bin) { bin.title = binInputs.title.value; update(); }
});
binInputs.lidLabel.addEventListener("input", () => {
  const bin = selected();
  if (bin) { bin.lidLabel = binInputs.lidLabel.value; update(); }
});
binInputs.height.addEventListener("input", () => {
  const bin = selected();
  if (!bin) return;
  const v = binInputs.height.valueAsNumber;
  bin.height = binInputs.height.value === "" || !(v > 0) ? null : v;
  update();
});
binInputs.fillet.addEventListener("input", () => {
  const bin = selected();
  const v = binInputs.fillet.valueAsNumber;
  if (bin && v >= 0) { bin.bottomFillet = v; update(); }
});
for (const input of [binInputs.title, binInputs.lidLabel, binInputs.height, binInputs.fillet]) {
  input.addEventListener("change", () => update(true));
}
typeSelect.addEventListener("change", () => {
  const bin = selected();
  if (bin) { bin.type = typeSelect.value as BinType; update(true); }
});
binInputs.pullTab.addEventListener("change", () => {
  const bin = selected();
  if (bin) { bin.pullTab = binInputs.pullTab.checked; update(true); }
});

function rotateSelected() {
  const bin = selected();
  if (!bin || bin.unitsX === bin.unitsY) return;
  const rect = { col: bin.col, row: bin.row, unitsX: bin.unitsY, unitsY: bin.unitsX };
  if (canPlace(layout, rect, bin.id)) {
    Object.assign(bin, rect);
    syncBinInputs();
    update(true);
  } else {
    binError(`No room to rotate to ${rect.unitsX}×${rect.unitsY} here.`);
  }
}

function deleteSelected() {
  if (!selectedId) return;
  layout.bins = layout.bins.filter((b) => b.id !== selectedId);
  selectedId = null;
  syncBinInputs();
  update(true);
}

function moveSelected(dCol: number, dRow: number) {
  const bin = selected();
  if (!bin) return;
  const rect = { col: bin.col + dCol, row: bin.row + dRow, unitsX: bin.unitsX, unitsY: bin.unitsY };
  if (canPlace(layout, rect, bin.id)) {
    Object.assign(bin, rect);
    update(true);
  }
}

$("bin-rotate").addEventListener("click", rotateSelected);
$("bin-delete").addEventListener("click", deleteSelected);

// ---- grid ------------------------------------------------------------------------

const grid = new GridEditor($("grid") as unknown as SVGSVGElement, {
  layout: () => layout,
  selectedId: () => selectedId,
  select,
  create(rect) {
    const bin = newBin(rect.col, rect.row, rect.unitsX, rect.unitsY);
    layout.bins.push(bin);
    selectedId = bin.id;
    syncBinInputs();
    update(true);
  },
  changed(done) {
    syncBinInputs();
    update(done);
  },
});

document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("input, select, textarea") || page !== "pack") return;
  if (e.key === "?") {
    e.preventDefault();
    $("keys").togglePopover();
    return;
  }
  if (document.querySelector(":popover-open")) return; // Esc closes it, nothing else
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) { if (historyIndex < history.length - 1) restore(historyIndex + 1); }
    else if (historyIndex > 0) restore(historyIndex - 1);
    return;
  }
  if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    if (historyIndex < history.length - 1) restore(historyIndex + 1);
    return;
  }
  if (mod || e.altKey) return;
  const moves: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
  };
  if (e.key === "r" || e.key === "R") rotateSelected();
  else if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
  else if (e.key === "Escape") select(null);
  else if (e.key in moves && selectedId) moveSelected(...moves[e.key]);
  else return;
  e.preventDefault();
});

// ---- render ----------------------------------------------------------------------

function render() {
  const s = layout.settings;
  const cx = cavityUnits(s.caseLength, s.gridSpacing, s.sideBorderUnits);
  const cy = cavityUnits(s.caseWidth, s.gridSpacing, s.frontBorderUnits);
  const preset = CASE_PRESETS.find((p) => p.length === s.caseLength && p.width === s.caseWidth);
  const caseHint = $("case-hint");
  caseHint.textContent =
    `floor(${s.caseLength} ÷ ${s.gridSpacing}) − ${s.sideBorderUnits} = ${cx}, ` +
    `floor(${s.caseWidth} ÷ ${s.gridSpacing}) − ${s.frontBorderUnits} = ${cy} grid units` +
    (preset ? ` · case depth ${preset.depth} mm` : "") +
    ". The border settings must match the perimeter's “Side / Front border bins” on casefinity.net.";
  caseHint.className = cx >= 1 && cy >= 1 && cx <= 60 && cy <= 60 ? "hint" : "hint bad";
  $("area-hint").textContent =
    `Area: ${fmt(s.areaX * s.gridSpacing)} × ${fmt(s.areaY * s.gridSpacing)} mm ` +
    `(${s.areaX} × ${s.areaY} grid units of 15 mm) inside the perimeter.`;
  $("clear-hint").textContent =
    `Registration clearance per flank. Default 0.10 (socket = w + 2c = ${fmt(s.ribWidth + 2 * s.clear)}). ` +
    `Applies project-wide — parts with different c don't fit together.`;

  const bin = selected();
  if (bin) {
    const [fx, fy] = footprint(bin, s);
    const [bx, by] = boundingBox(bin, s);
    const z = buildHeight(bin, s);
    const fits = fitsBed(bin, s);
    const dims = $("bin-dims");
    dims.textContent =
      `Footprint ${fmt(fx)} × ${fmt(fy)} mm · Bounding box ${fmt(bx)} × ${fmt(by)} mm` +
      (fits ? "" : " — does not fit the print bed");
    dims.className = fits ? "hint" : "hint bad";
    $("bin-heading").textContent = `Bin ${bin.unitsX}×${bin.unitsY}`;
    binInputs.height.placeholder = String(s.overallHeight);
    $("lid-label-row").hidden = bin.type !== "with-lid";
    $("fillet-row").hidden = bin.type !== "double-sided";
    $("bin-tab-hint").textContent = bin.pullTab
      ? `Build height ${z} mm — the tab stands ${s.pullTabHeight} mm above the rim.`
      : `Build height ${z} mm.`;
    ($("bin-rotate") as HTMLButtonElement).disabled = bin.unitsX === bin.unitsY;
  }

  const checks = $("checks");
  checks.replaceChildren(
    ...runChecks(layout).map((c) => {
      const p = document.createElement("p");
      p.className = `check-line ${c.level}`;
      p.textContent = `${c.level === "ok" ? "✓" : c.level === "warn" ? "!" : "✗"} ${c.text}`;
      return p;
    }),
  );

  const parts = groupParts(layout);
  const exportBtn = $<HTMLButtonElement>("export");
  exportBtn.textContent = layout.bins.length
    ? `Export ${layout.bins.length} bin(s) as ZIP` + (parts.length < layout.bins.length ? ` (${parts.length} unique)` : "")
    : "Export as ZIP";
  exportBtn.disabled = !kernelReady || exporting || layout.bins.length === 0;

  grid.render();
  itemsPage.refresh();
  autoPackCard.refresh();
  if (page === "print") printPage.render();
  if (view === "case") {
    scheduleCase();
    renderFillTable();
  } else {
    schedulePreview();
  }
}

// ---- export, save, load ----------------------------------------------------------

let kernelReady = false;
let exporting = false;
const status = $("status");

function download(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

$("export").addEventListener("click", async () => {
  const formats: ExportFormat[] = ["stl"];
  if ($<HTMLInputElement>("export-step").checked) formats.push("step");
  if ($<HTMLInputElement>("export-3mf").checked) formats.push("3mf");
  exporting = true;
  render();
  const t0 = performance.now();
  try {
    const zip = await exportZip(cad, layout, formats, (done, total) => {
      status.textContent = `Building part ${Math.min(done + 1, total)} of ${total}…`;
    });
    download(zip as Uint8Array<ArrayBuffer>, "casefinity-bins.zip", "application/zip");
    status.textContent = `Exported in ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
  } catch (err) {
    console.error(err);
    status.textContent = `Export failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    exporting = false;
    render();
  }
});

$("save-layout").addEventListener("click", () => {
  download(serializeLayout(layout), "casefinity-layout.json", "application/json");
});

const loadFile = $<HTMLInputElement>("load-file");
$("load-layout").addEventListener("click", () => loadFile.click());
loadFile.addEventListener("change", async () => {
  const file = loadFile.files?.[0];
  loadFile.value = "";
  if (!file) return;
  try {
    layout = parseLayout(await file.text());
    selectedId = null;
    syncSettingInputs();
    syncBinInputs();
    itemsPage.rebuild();
    update(true);
    status.textContent = `Loaded ${file.name} (${layout.bins.length} bins).`;
  } catch (err) {
    status.textContent = `Couldn't load ${file.name}: ${err instanceof Error ? err.message : String(err)}`;
  }
});

$("clear-layout").addEventListener("click", () => {
  if (layout.bins.length && !confirm("Remove all bins? (Ctrl+Z undoes this.)")) return;
  layout.bins = [];
  selectedId = null;
  syncBinInputs();
  update(true);
});

// ---- 3D preview ------------------------------------------------------------------

let viewer: Promise<BinView | null> | undefined;
/** The viewer once it exists, for the section toolbar's synchronous handlers. */
let binView: BinView | null = null;
let previewTimer: number | undefined;
let previewSeq = 0;
let lastPreviewKey = "";
let lastFramedId = "";
let lastMeshes: Awaited<ReturnType<CadWorkerApi["mesh"]>> = [];
const previewStatus = $("preview-status");

function getViewer(): Promise<BinView | null> {
  viewer ??= import("./binView.ts").then(
    ({ BinView }) => {
      try {
        binView = new BinView($("preview"));
        syncSectionBar(binView);
        return binView;
      } catch (err) {
        console.error(err);
        return null;
      }
    },
  );
  return viewer;
}

/** The selected bin's items, placed in the bin frame, for the preview. */
function binSolids(bin: Bin): Solid[] {
  const item = bin.itemId ? layout.items.find((it) => it.id === bin.itemId) : undefined;
  if (!item) return [];
  const sizing = sizeItem(item, layout.settings);
  return (sizing.ok && placeInBin(item, sizing, bin, layout.settings)) || [];
}

function schedulePreview() {
  if (view !== "bin") return;
  const bin = selected();
  renderSectionReadout(bin);
  const key = bin ? JSON.stringify([modelIdFor(bin.type), binParams(bin, layout.settings)]) : "";
  if (key === lastPreviewKey) {
    // Same CAD part: only the items (if any) may have changed
    if (bin) void getViewer().then((v) => v?.update(lastMeshes, binSolids(bin)));
    return;
  }
  lastPreviewKey = key;
  clearTimeout(previewTimer);
  const seq = ++previewSeq;
  if (!bin) {
    previewStatus.textContent = "Select a bin to preview it.";
    lastMeshes = [];
    void getViewer().then((v) => v?.update([], []));
    return;
  }
  previewStatus.textContent = "Building preview…";
  previewTimer = window.setTimeout(async () => {
    if (!kernelReady) await cad.ready();
    const v = await getViewer();
    if (!v) {
      previewStatus.textContent = "3D preview unavailable (no WebGL).";
      return;
    }
    try {
      const t0 = performance.now();
      const meshes = await cad.mesh(modelIdFor(bin.type), binParams(bin, layout.settings));
      if (seq !== previewSeq) return; // superseded while building
      lastMeshes = meshes;
      v.update(meshes, binSolids(bin));
      if (lastFramedId !== bin.id) {
        v.frame();
        lastFramedId = bin.id;
      }
      syncSectionBar(v);
      previewStatus.textContent = `${bin.unitsX}×${bin.unitsY} ${BIN_TYPES.find((t) => t.value === bin.type)!.label.toLowerCase()} · built in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    } catch (err) {
      if (seq === previewSeq) previewStatus.textContent = `Preview failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }, 350);
}

// ---- section tool ------------------------------------------------------------------

const secToggle = $<HTMLButtonElement>("sec-toggle");
const secPos = $<HTMLInputElement>("sec-pos");
const secPosNum = $<HTMLInputElement>("sec-pos-num");
const secGhost = $<HTMLInputElement>("sec-ghost");
const secAxisButtons = [...document.querySelectorAll<HTMLButtonElement>("#sec-axis button")];
const secRib = $<HTMLButtonElement>("sec-snap-rib");
const showItems = $<HTMLInputElement>("show-items");

/** Mirror the viewer's section state (and the bin's cut range) into the toolbar. */
function syncSectionBar(v: BinView) {
  const sec = v.section;
  const [lo, hi] = v.range(sec.axis);
  secToggle.setAttribute("aria-pressed", String(sec.enabled));
  for (const b of secAxisButtons) b.setAttribute("aria-pressed", String(b.dataset.axis === sec.axis));
  for (const input of [secPos, secPosNum]) {
    input.min = lo.toFixed(1);
    input.max = hi.toFixed(1);
  }
  secPos.value = String(sec.pos);
  secPosNum.value = sec.pos.toFixed(1);
  secGhost.checked = sec.ghost;
  secRib.hidden = sec.axis === "z";
  const bin = selected();
  showItems.disabled = !bin || binSolids(bin).length === 0;
  $("section-bar").classList.toggle("off", !sec.enabled);
}

/** Change the section; any change but switching it off turns it on. */
function setSection(patch: Partial<BinView["section"]>) {
  if (!binView) return;
  binView.setSection({ enabled: true, ...patch });
  syncSectionBar(binView);
}

secToggle.addEventListener("click", () => {
  if (binView) setSection({ enabled: !binView.section.enabled });
});
for (const b of secAxisButtons) {
  b.addEventListener("click", () => {
    if (!binView) return;
    const axis = b.dataset.axis as Axis;
    if (axis === binView.section.axis) return setSection({});
    // Start a new axis at its middle (Z: halfway up)
    const [lo, hi] = binView.range(axis);
    setSection({ axis, pos: (lo + hi) / 2 });
  });
}
secPos.addEventListener("input", () => setSection({ pos: secPos.valueAsNumber }));
secPosNum.addEventListener("change", () => {
  if (Number.isFinite(secPosNum.valueAsNumber)) setSection({ pos: secPosNum.valueAsNumber });
});
$("sec-face").addEventListener("click", () => {
  setSection({});
  binView?.faceCut();
});
$("sec-flip").addEventListener("click", () => {
  if (binView) setSection({ flipped: !binView.section.flipped });
});
secGhost.addEventListener("change", () => setSection({ ghost: secGhost.checked }));
$("sec-snap-center").addEventListener("click", () => {
  if (!binView) return;
  const [lo, hi] = binView.range(binView.section.axis);
  setSection({ pos: binView.section.axis === "z" ? (lo + hi) / 2 : 0 });
});
showItems.addEventListener("change", () => binView?.setShowItems(showItems.checked));
// Steps through the grid-unit centres — each one cuts through a rib and its socket
secRib.addEventListener("click", () => {
  const bin = selected();
  if (!bin || !binView || binView.section.axis === "z") return;
  const n = binView.section.axis === "x" ? bin.unitsX : bin.unitsY;
  const P = layout.settings.gridSpacing;
  const centers = Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * P);
  setSection({ pos: centers.find((c) => c > binView!.section.pos + 0.05) ?? centers[0] });
});

// Keys while the preview has focus; kept from the grid's own arrow / R handling.
const SECTION_KEYS: Record<string, (shift: boolean) => void> = {
  s: () => secToggle.click(),
  x: () => secAxisButtons[0].click(),
  y: () => secAxisButtons[1].click(),
  z: () => secAxisButtons[2].click(),
  f: () => $("sec-flip").click(),
  v: () => $("sec-face").click(),
  "?": () => $("preview-keys").togglePopover(),
  arrowup: (shift) => binView && setSection({ pos: binView.section.pos + (shift ? 5 : 1) }),
  arrowright: (shift) => SECTION_KEYS.arrowup(shift),
  arrowdown: (shift) => binView && setSection({ pos: binView.section.pos - (shift ? 5 : 1) }),
  arrowleft: (shift) => SECTION_KEYS.arrowdown(shift),
};
$("preview").addEventListener("keydown", (e) => {
  const action = SECTION_KEYS[e.key.toLowerCase()];
  if (!action || e.ctrlKey || e.metaKey || e.altKey) return;
  action(e.shiftKey);
  e.preventDefault();
  e.stopPropagation();
});

/** Where the selected bin's items sit: floor, item top, and the gap to the rim. */
function renderSectionReadout(bin: Bin | undefined) {
  const out = $("section-readout");
  const s = layout.settings;
  const solids = bin ? binSolids(bin) : [];
  if (!bin || !solids.length) {
    out.textContent = bin ? `Floor ${fmt1(s.floorThick)} mm · rim ${fmt1(bin.height ?? s.overallHeight)} mm · no item assigned` : "";
    out.classList.remove("warn");
    return;
  }
  const rim = bin.height ?? s.overallHeight;
  const top = Math.max(...solids.map((so) => so.cz + (so.kind === "box" ? so.sz : so.axis === "z" ? so.len : 2 * so.r) / 2));
  const gap = rim - top;
  const deep = gap > (rim - s.floorThick) / 2;
  out.textContent =
    `Floor ${fmt1(s.floorThick)} mm · item top ${fmt1(top)} mm · rim ${fmt1(rim)} mm · ` +
    `gap to rim ${fmt1(gap)} mm` + (deep ? " ⚠ item sits deep — hard to reach" : "");
  out.classList.toggle("warn", deep);
}

// ---- items page, auto-pack, pages --------------------------------------------------

const itemsPage = new ItemsPage($("items-page"), {
  layout: () => layout,
  changed: (commit) => update(commit),
  autoPack() {
    location.hash = "#pack";
    showPage();
    autoPackCard.run();
  },
});

const autoPackCard = new AutoPackCard($("autopack-card"), {
  layout: () => layout,
  apply(bins) {
    layout.bins = bins;
    selectedId = null;
    syncBinInputs();
    setView("case");
    update(true);
  },
});

const printPage = new PrintPage($("print-page"), {
  layout: () => layout,
  cad,
  kernelReady: () => kernelReady,
  download,
});

const PAGES = ["items", "pack", "print"] as const;
type Page = (typeof PAGES)[number];
let page: Page = "pack";

/** #items, #pack or #print; with no hash, start on Items until there are bins to show. */
function showPage() {
  const hash = location.hash.slice(1) as Page;
  page = PAGES.includes(hash) ? hash : layout.bins.length || !layout.items.length ? "pack" : "items";
  $("items-page").hidden = page !== "items";
  $("app").hidden = page !== "pack";
  $("print-page").hidden = page !== "print";
  for (const p of PAGES) {
    const link = $(`step-${p}`);
    if (p === page) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  render();
}
window.addEventListener("hashchange", showPage);

// ---- preview: whole case or the selected bin -------------------------------------

type View = "case" | "bin";
let view: View = "case";

function setView(next: View) {
  view = next;
  $("view-case").setAttribute("aria-pressed", String(next === "case"));
  $("view-bin").setAttribute("aria-pressed", String(next === "bin"));
  $("case-view").hidden = next !== "case";
  $("fill-wrap").hidden = next !== "case";
  $("preview").hidden = next !== "bin";
  $("section-bar").hidden = next !== "bin";
  $("preview-keys-btn").hidden = next !== "bin";
  $("section-readout").hidden = next !== "bin";
  lastPreviewKey = "";
}
$("view-case").addEventListener("click", () => { setView("case"); render(); });
$("view-bin").addEventListener("click", () => { setView("bin"); render(); });

let caseView: Promise<CaseView | null> | undefined;
let caseFrame = 0;

function scheduleCase() {
  cancelAnimationFrame(caseFrame);
  caseFrame = requestAnimationFrame(async () => {
    caseView ??= import("./caseView.ts").then(({ CaseView }) => {
      try {
        return new CaseView($("case-view"));
      } catch (err) {
        console.error(err);
        return null;
      }
    });
    const v = await caseView;
    if (!v) {
      previewStatus.textContent = "3D preview unavailable (no WebGL).";
      return;
    }
    v.update(layout, selectedId);
    previewStatus.textContent = layout.bins.length ? "Drag to orbit · scroll to zoom" : "No bins yet.";
  });
}

/** How much of each item bin its items fill, by volume and by depth. */
function renderFillTable() {
  const s = layout.settings;
  const items = new Map(layout.items.map((it) => [it.id, it]));
  const rows: HTMLTableRowElement[] = [];
  for (const bin of layout.bins) {
    const item = bin.itemId ? items.get(bin.itemId) : undefined;
    if (!item) continue;
    const sizing = sizeItem(item, s);
    const solids = sizing.ok ? placeInBin(item, sizing, bin, s) : null;
    const tr = document.createElement("tr");
    tr.className = bin.id === selectedId ? "selected" : "";
    const name = document.createElement("button");
    name.type = "button";
    name.className = "linklike";
    name.textContent = `${bin.title || item.name || "Item"} · ${bin.unitsX}×${bin.unitsY}`;
    name.addEventListener("click", () => select(bin.id));
    const cells: (string | Node)[] = [name];
    if (!solids || !sizing.ok) {
      cells.push("doesn't fit", "—", "—");
    } else {
      const vol = solids.reduce((a, so) => a + solidVolume(so), 0);
      const space = insideVolume(bin, s);
      const pct = Math.round((vol / space) * 100);
      const bar = document.createElement("span");
      bar.className = "fill-bar";
      const inner = document.createElement("span");
      inner.style.width = `${Math.min(100, pct)}%`;
      bar.append(inner);
      const fill = document.createDocumentFragment();
      fill.append(bar, `${pct} %`);
      const depth = Math.round((sizing.pose.z / insideHeight(s, bin.height ?? s.overallHeight)) * 100);
      cells.push(`${(vol / 1e6).toFixed(2)} / ${(space / 1e6).toFixed(2)} L`, fill, `${depth} %`);
    }
    for (const c of cells) {
      const td = document.createElement("td");
      td.append(c);
      tr.append(td);
    }
    rows.push(tr);
  }
  $("fill-body").replaceChildren(...rows);
  $("fill-wrap").hidden = rows.length === 0;
}

// ---- start -----------------------------------------------------------------------

syncSettingInputs();
syncBinInputs();
itemsPage.rebuild();
showPage();
render();
cad.ready().then(
  () => {
    kernelReady = true;
    status.textContent = "CAD kernel ready.";
    render();
    if (page === "print") printPage.render();
  },
  (err) => { status.textContent = `CAD kernel failed to load: ${err}`; },
);
