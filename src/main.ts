import "./style.css";
import { wrap } from "comlink";
import type { CadWorkerApi, ExportFormat } from "./worker.ts";
import {
  BIN_TYPES,
  CASE_PRESETS,
  DEFAULT_SETTINGS,
  cavityModules,
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

const cad = wrap<CadWorkerApi>(new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }));

const STORAGE_KEY = "casefinity-planner/layout";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number) => n.toFixed(2);

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
  "sideBorderModules", "frontBorderModules", "bedX", "bedY", "bedZ",
];
const integerSettings = new Set<keyof Settings>(["areaX", "areaY", "sideBorderModules", "frontBorderModules"]);
const zeroAllowed = new Set<keyof Settings>(["draftAngle", "sideBorderModules", "frontBorderModules"]);

function syncSettingInputs() {
  for (const key of settingKeys) $<HTMLInputElement>(key).value = String(layout.settings[key]);
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
    if (key === "sideBorderModules" || key === "frontBorderModules") applyCaseSize();
    syncSettingInputs();
    update(true);
  });
}

const presetSelect = $<HTMLSelectElement>("case-preset");
presetSelect.add(new Option("Custom — enter case size", ""));
for (const p of CASE_PRESETS) {
  const s = DEFAULT_SETTINGS;
  const x = cavityModules(p.length, s.gridSpacing, s.sideBorderModules);
  const y = cavityModules(p.width, s.gridSpacing, s.frontBorderModules);
  presetSelect.add(new Option(`${p.label} (${x} × ${y} modules at defaults)`, p.label));
}

/** Area modules from the case-size inputs, with casefinity's perimeter formula. */
function applyCaseSize() {
  const s = layout.settings;
  const hint = $("case-hint");
  const mmX = $<HTMLInputElement>("mmX").valueAsNumber;
  const mmY = $<HTMLInputElement>("mmY").valueAsNumber;
  if (!(mmX > 0 && mmY > 0)) return;
  const x = cavityModules(mmX, s.gridSpacing, s.sideBorderModules);
  const y = cavityModules(mmY, s.gridSpacing, s.frontBorderModules);
  if (x < 1 || y < 1 || x > 60 || y > 60) {
    hint.textContent = `That gives ${x} × ${y} modules — check the case size and border modules.`;
    hint.className = "hint bad";
    return;
  }
  s.areaX = x;
  s.areaY = y;
  const preset = CASE_PRESETS.find((p) => p.label === presetSelect.value);
  hint.textContent =
    `floor(${mmX} ÷ ${s.gridSpacing}) − ${s.sideBorderModules} = ${x}, ` +
    `floor(${mmY} ÷ ${s.gridSpacing}) − ${s.frontBorderModules} = ${y} modules` +
    (preset ? ` · case depth ${preset.depth} mm` : "") + ".";
  hint.className = "hint";
  syncSettingInputs();
}

presetSelect.addEventListener("change", () => {
  const preset = CASE_PRESETS.find((p) => p.label === presetSelect.value);
  if (!preset) return;
  $<HTMLInputElement>("mmX").value = String(preset.length);
  $<HTMLInputElement>("mmY").value = String(preset.width);
  applyCaseSize();
  update(true);
});
for (const id of ["mmX", "mmY"]) {
  $(id).addEventListener("input", () => { presetSelect.value = ""; });
}

$("mm-to-modules").addEventListener("click", () => {
  applyCaseSize();
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
  binInputs.mx.value = String(bin.modulesX);
  binInputs.my.value = String(bin.modulesY);
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

/** Resize the selected bin from the module inputs, if there's room. */
function resizeSelected() {
  const bin = selected();
  if (!bin) return;
  const mx = Math.round(binInputs.mx.valueAsNumber);
  const my = Math.round(binInputs.my.valueAsNumber);
  if (!(mx >= 1 && my >= 1)) return;
  const rect = { col: bin.col, row: bin.row, modulesX: mx, modulesY: my };
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
  if (!bin || bin.modulesX === bin.modulesY) return;
  const rect = { col: bin.col, row: bin.row, modulesX: bin.modulesY, modulesY: bin.modulesX };
  if (canPlace(layout, rect, bin.id)) {
    Object.assign(bin, rect);
    syncBinInputs();
    update(true);
  } else {
    binError(`No room to rotate to ${rect.modulesX}×${rect.modulesY} here.`);
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
  const rect = { col: bin.col + dCol, row: bin.row + dRow, modulesX: bin.modulesX, modulesY: bin.modulesY };
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
    const bin = newBin(rect.col, rect.row, rect.modulesX, rect.modulesY);
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
  if (t.closest("input, select, textarea")) return;
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
  $("area-hint").textContent =
    `Area: ${fmt(s.areaX * s.gridSpacing)} × ${fmt(s.areaY * s.gridSpacing)} mm ` +
    `(${s.areaX} × ${s.areaY} modules) inside the perimeter.`;
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
    $("bin-heading").textContent = `Bin ${bin.modulesX}×${bin.modulesY}`;
    binInputs.height.placeholder = String(s.overallHeight);
    $("lid-label-row").hidden = bin.type !== "with-lid";
    $("fillet-row").hidden = bin.type !== "double-sided";
    $("bin-tab-hint").textContent = bin.pullTab
      ? `Build height ${z} mm — the tab stands ${s.pullTabHeight} mm above the rim.`
      : `Build height ${z} mm.`;
    ($("bin-rotate") as HTMLButtonElement).disabled = bin.modulesX === bin.modulesY;
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
  schedulePreview();
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

type ViewerInstance = InstanceType<typeof import("./vendor/casefinity/viewer.ts").Viewer>;
let viewer: Promise<ViewerInstance | null> | undefined;
let previewTimer: number | undefined;
let previewSeq = 0;
let lastPreviewKey = "";
let lastFramedId = "";
const previewStatus = $("preview-status");

function getViewer(): Promise<ViewerInstance | null> {
  viewer ??= import("./vendor/casefinity/viewer.ts").then(
    ({ Viewer }) => {
      try {
        return new Viewer($("preview"));
      } catch (err) {
        console.error(err);
        return null;
      }
    },
  );
  return viewer;
}

function schedulePreview() {
  const bin = selected();
  const key = bin ? JSON.stringify([modelIdFor(bin.type), binParams(bin, layout.settings)]) : "";
  if (key === lastPreviewKey) return;
  lastPreviewKey = key;
  clearTimeout(previewTimer);
  const seq = ++previewSeq;
  if (!bin) {
    previewStatus.textContent = "Select a bin to preview it.";
    void getViewer().then((v) => v?.update([]));
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
      v.update(meshes);
      if (lastFramedId !== bin.id) {
        v.frame();
        lastFramedId = bin.id;
      }
      previewStatus.textContent = `${bin.modulesX}×${bin.modulesY} ${BIN_TYPES.find((t) => t.value === bin.type)!.label.toLowerCase()} · built in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    } catch (err) {
      if (seq === previewSeq) previewStatus.textContent = `Preview failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }, 350);
}

// ---- start -----------------------------------------------------------------------

syncSettingInputs();
syncBinInputs();
render();
cad.ready().then(
  () => {
    kernelReady = true;
    status.textContent = "CAD kernel ready.";
    render();
  },
  (err) => { status.textContent = `CAD kernel failed to load: ${err}`; },
);
