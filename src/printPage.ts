import { strToU8, zipSync } from "fflate";
import type { Zippable } from "fflate";
import type { Remote } from "comlink";
import type { CadWorkerApi } from "./worker.ts";
import { binParams, fileStem, isSpacer, modelIdFor } from "./bins.ts";
import type { Bin, Layout } from "./bins.ts";
import { serializeLayout } from "./layout.ts";
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
  private exporting = false;
  private status: HTMLElement;
  private exportButton: HTMLButtonElement;

  constructor(private root: HTMLElement, private hooks: PrintHooks) {
    this.status = root.querySelector("#plates-status")!;
    this.exportButton = root.querySelector("#export-plates")!;
    this.exportButton.addEventListener("click", () => void this.exportPlates());
  }

  render() {
    const layout = this.hooks.layout();
    const s = layout.settings;
    this.plan = planPlates(layout.bins, s);
    const bins = new Map(layout.bins.map((b) => [b.id, b]));
    const nums = binNumbers(layout.bins);

    this.root.querySelector("#plates-title")!.textContent = layout.bins.length
      ? `${this.plan.plates.length} plate${this.plan.plates.length === 1 ? "" : "s"} on a ${s.bedX} × ${s.bedY} mm bed`
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
      notes.push(Object.assign(document.createElement("p"), { className: "hint", textContent: "No bins yet — add items and auto-pack, or draw bins on the Pack page." }));
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
      this.hooks.download(zipSync(files) as Uint8Array<ArrayBuffer>, "casefinity-plates.zip", "application/zip");
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
