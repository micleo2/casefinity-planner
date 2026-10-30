import { strToU8, zipSync } from "fflate";
import type { Zippable } from "fflate";
import type { Remote } from "comlink";
import type { CadWorkerApi } from "./worker.ts";
import { binParams, fileStem, isSpacer, modelIdFor } from "./bins.ts";
import type { Bin, Layout } from "./bins.ts";
import { exportName, serializeLayout } from "./layout.ts";
import { binNumbers, planPlates } from "./plates.ts";
import type { PlatePlan } from "./plates.ts";

/**
 * The Print page: bins arranged onto print-bed plates (one 3MF per plate in
 * the export).
 */

export interface PrintHooks {
  layout(): Layout;
  cad: Remote<CadWorkerApi>;
  kernelReady(): boolean;
  download(data: BlobPart, name: string, type: string): void;
  /** The print selection changed. */
  selectionChanged(): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

export class PrintPage {
  private plan: PlatePlan = { plates: [], tooBig: [] };
  /** Bins left out of printing. New bins start selected. */
  private excluded = new Set<string>();
  /** What the picker list was built from; ticking only updates it in place. */
  private pickerKey = "";
  private exporting = false;
  private status: HTMLElement;
  private exportButton: HTMLButtonElement;

  constructor(private root: HTMLElement, private hooks: PrintHooks) {
    this.status = root.querySelector("#plates-status")!;
    this.exportButton = root.querySelector("#export-plates")!;
    this.exportButton.addEventListener("click", () => void this.exportPlates());
    root.querySelector("#pick-all")!.addEventListener("click", () => this.setExcluded([]));
    root.querySelector("#pick-none")!.addEventListener("click", () => this.setExcluded(this.hooks.layout().bins.map((b) => b.id)));
  }

  /** The bins ticked for printing, in layout order. */
  selectedBins(): Bin[] {
    return this.hooks.layout().bins.filter((b) => !this.excluded.has(b.id));
  }

  private setExcluded(ids: Iterable<string>) {
    this.excluded = new Set(ids);
    this.hooks.selectionChanged();
  }

  render() {
    const layout = this.hooks.layout();
    const s = layout.settings;
    const bins = new Map(layout.bins.map((b) => [b.id, b]));
    for (const id of this.excluded) if (!bins.has(id)) this.excluded.delete(id);
    const nums = binNumbers(layout.bins);
    const selected = this.selectedBins();
    this.plan = planPlates(selected, s, { nums });
    this.renderPicker(layout.bins, nums);

    const n = this.plan.plates.length;
    this.root.querySelector("#plates-title")!.textContent = selected.length
      ? `${n} plate${n === 1 ? "" : "s"} for ${selected.length} of ${layout.bins.length} bins · ${s.bedX} × ${s.bedY} mm bed`
      : "Plates";
    this.root.querySelector("#plates-note")!.textContent = "Footprints include the ribs; parts print standing, open side up.";

    const plates = this.root.querySelector("#plates")!;
    const scale = 240 / Math.max(s.bedX, s.bedY);
    const cards = this.plan.plates.map((plate, i) => {
      const svg = svgEl("svg", { viewBox: `0 0 ${s.bedX} ${s.bedY}`, class: "plate", role: "img" }) as SVGSVGElement;
      svg.setAttribute("aria-label", `Plate ${i + 1} with parts ${plate.parts.map((p) => p.num).join(", ")}`);
      svg.style.width = `${s.bedX * scale}px`;
      svg.append(svgEl("rect", { x: 0, y: 0, width: s.bedX, height: s.bedY, class: "bed" }));
      for (const p of plate.parts) {
        const bin = bins.get(p.binId)!;
        svg.append(svgEl("rect", { x: p.x, y: p.y, width: p.w, height: p.h, class: isSpacer(bin) ? "part spacer" : "part" }));
        const label = svgEl("text", { x: p.x + p.w / 2, y: p.y + p.h / 2, class: "part-num" }, String(p.num));
        label.style.fontSize = `${Math.min(28, Math.max(10, Math.min(p.w, p.h) * 0.45))}px`;
        svg.append(label);
      }
      const card = document.createElement("figure");
      card.className = "plate-card";
      const caption = document.createElement("figcaption");
      caption.textContent = `Plate ${i + 1} · ${plate.parts.length} part${plate.parts.length === 1 ? "" : "s"}: ${plate.parts.map((p) => p.num).join(", ")}`;
      card.append(svg, caption);
      return card;
    });
    const notes: HTMLElement[] = [];
    if (!layout.bins.length) {
      notes.push(Object.assign(document.createElement("p"), { className: "hint", textContent: "No bins yet — add items and auto-pack, or draw bins on the Prepare page." }));
    } else if (!selected.length) {
      notes.push(Object.assign(document.createElement("p"), { className: "hint", textContent: "No bins selected — tick the ones to print under Bins to print." }));
    }
    if (this.plan.tooBig.length) {
      notes.push(Object.assign(document.createElement("p"), {
        className: "hint bad",
        textContent: `Too big for the bed: ${this.plan.tooBig.map((id) => `#${nums.get(id)} ${bins.get(id)!.title || ""}`.trim()).join(", ")}.`,
      }));
    }
    plates.replaceChildren(...notes, ...cards);
    this.exportButton.disabled = !this.hooks.kernelReady() || this.exporting || this.plan.plates.length === 0;
  }

  /** One checkbox per bin, by part number. */
  private renderPicker(all: Bin[], nums: Map<string, number>) {
    const list = this.root.querySelector("#pick-list")!;
    const key = JSON.stringify(all.map((b) => [b.id, nums.get(b.id), b.title, b.unitsX, b.unitsY, isSpacer(b)]));
    if (key === this.pickerKey) {
      for (const box of list.querySelectorAll<HTMLInputElement>("input")) box.checked = !this.excluded.has(box.value);
      return;
    }
    this.pickerKey = key;
    const rows = [...all].sort((a, b) => nums.get(a.id)! - nums.get(b.id)!).map((b) => {
      const box = Object.assign(document.createElement("input"), { type: "checkbox", value: b.id, checked: !this.excluded.has(b.id) });
      box.addEventListener("change", () => {
        const next = new Set(this.excluded);
        if (box.checked) next.delete(b.id);
        else next.add(b.id);
        this.setExcluded(next);
      });
      const row = document.createElement("label");
      row.className = isSpacer(b) ? "check spacer" : "check";
      row.append(
        box,
        Object.assign(document.createElement("span"), { className: "pick-num", textContent: `#${nums.get(b.id)}` }),
        b.title || "Bin",
        Object.assign(document.createElement("span"), { className: "pick-size", textContent: `${b.unitsX} × ${b.unitsY}` }),
      );
      return row;
    });
    list.replaceChildren(...rows);
    for (const id of ["pick-all", "pick-none"]) this.root.querySelector<HTMLButtonElement>(`#${id}`)!.disabled = !all.length;
  }

  private async exportPlates() {
    const layout = this.hooks.layout();
    const s = layout.settings;
    const bins = new Map(layout.bins.map((b) => [b.id, b]));
    this.exporting = true;
    this.render();
    const t0 = performance.now();
    try {
      const files: Zippable = {};
      for (const [i, plate] of this.plan.plates.entries()) {
        this.status.textContent = `Building plate ${i + 1} of ${this.plan.plates.length}…`;
        const jobs = plate.parts.map((p) => {
          const bin = bins.get(p.binId)!;
          return { modelId: modelIdFor(bin.type), params: binParams(bin, s), name: `${p.num}-${fileStem(bin)}`, x: p.x, y: p.y, turned: p.turned };
        });
        const { plate: bytes, extras } = await this.hooks.cad.exportPlate(jobs, s.bedY, `Plate ${i + 1}`);
        files[`plates/plate-${i + 1}.3mf`] = [bytes, { level: 0 }];
        for (const x of extras) files[`lids/${x.name}.3mf`] = [x.bytes, { level: 0 }];
      }
      files["layout.json"] = strToU8(serializeLayout(layout));
      this.hooks.download(zipSync(files) as Uint8Array<ArrayBuffer>, exportName(layout, "plates.zip"), "application/zip");
      this.status.textContent = `Exported ${this.plan.plates.length} plate(s) in ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
    } catch (err) {
      console.error(err);
      this.status.textContent = `Export failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.exporting = false;
      this.render();
    }
  }
}
