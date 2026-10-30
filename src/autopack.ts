import { newBin } from "./bins.ts";
import type { Bin, Layout } from "./bins.ts";
import { fitsBed } from "./layout.ts";
import { autoPack } from "./pack.ts";
import type { Demand, PackOption } from "./pack.ts";
import { sizeItem } from "./sizing.ts";

/**
 * Auto-pack, inside the Items panel on the Pack page: size every item, find the best
 * full-columns and full-rows layouts, draw each as a thumbnail and apply the
 * chosen one. Item bins keep their snug size; spare grid units become spacers
 * (pack.ts can also grow bins into them, but that's switched off for now).
 */

export interface AutoPackHooks {
  layout(): Layout;
  /** Replace the layout's bins with these (one undo step). */
  apply(bins: Bin[]): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Everything sizing and packing depend on — options go stale when it changes. */
function packKey(layout: Layout): string {
  const s = layout.settings;
  return JSON.stringify([layout.items, s.areaX, s.areaY, s.gridSpacing, s.clear, s.wallThick, s.wallBump, s.floorThick,
    s.overallHeight, s.itemPlay, s.bedX, s.bedY, s.bedZ]);
}

export class AutoPackCard {
  private options: PackOption[] = [];
  /** The options are the closest layouts, not ones that hold every item. */
  private partial = false;
  /** Each sized item's snug bin, "3×13", for naming what a layout leaves out. */
  private sizes = new Map<string, string>();
  private key = "";
  private list: HTMLElement;
  private summary: HTMLElement;
  private runButton: HTMLButtonElement;

  constructor(root: HTMLElement, private hooks: AutoPackHooks) {
    this.list = root.querySelector("#autopack-options")!;
    this.summary = root.querySelector("#autopack-summary")!;
    this.runButton = root.querySelector("#autopack-run")!;
    this.runButton.addEventListener("click", () => this.run());
  }

  /** Size the items and pack them. */
  run() {
    const layout = this.hooks.layout();
    const s = layout.settings;
    const demands: Demand[] = [];
    const broken: string[] = [];
    this.sizes.clear();
    for (const item of layout.items) {
      if (item.off) continue;
      const r = sizeItem(item, s);
      if (r.ok) {
        demands.push({ id: item.id, unitsX: r.unitsX, unitsY: r.unitsY });
        this.sizes.set(item.id, `${r.unitsX}×${r.unitsY}`);
      }
      else broken.push(item.name || "unnamed item");
    }
    const fits = (ux: number, uy: number) => fitsBed(newBin(0, 0, ux, uy), s);
    const result = autoPack(s.areaX, s.areaY, demands, fits, { growth: "spacers" });
    this.options = result.options;
    this.partial = result.partial;
    this.key = packKey(layout);
    const name = (id: string) => layout.items.find((it) => it.id === id)?.name || "unnamed item";
    const problems = [
      ...(broken.length ? [`Can't size: ${broken.join(", ")} (open them above).`] : []),
      ...(result.unplaceable.length ? [`Doesn't fit: ${result.unplaceable.map(name).join(", ")}.`] : []),
    ];
    this.renderOptions(problems);
  }

  /** Called on every render: show the item count, and drop options that went stale. */
  refresh() {
    const layout = this.hooks.layout();
    const n = layout.items.filter((it) => !it.off).length;
    this.runButton.disabled = n === 0;
    this.runButton.textContent = this.options.length ? "Find layouts again" : "Find layouts";
    if (this.key && this.key !== packKey(layout)) {
      this.options = [];
      this.key = "";
      this.list.replaceChildren();
    }
    if (!this.options.length && !this.list.childElementCount) {
      this.summary.className = "hint";
      this.summary.textContent = n === 0
        ? "Add items above, then auto-pack them into transport-safe layouts."
        : `Lays out all ${n} item${n === 1 ? "" : "s"}; every layout fills whole rows or columns.`;
    }
  }

  private renderOptions(problems: string[]) {
    const layout = this.hooks.layout();
    this.summary.textContent = !this.options.length
      ? "None of the items fit this case."
      : this.partial
        ? "Not every item fits. These are the closest layouts — each lists what it leaves out. Use one as a start, or remove or shrink those items."
        : `${this.options.length} layout${this.options.length === 1 ? "" : "s"} found. Using one replaces the bins on the grid (Ctrl+Z undoes it).`;
    this.summary.className = this.partial ? "hint bad" : "hint";
    const cards = this.options.map((opt) => this.optionCard(opt, layout));
    const notes = problems.map((p) => Object.assign(document.createElement("p"), { className: "hint bad", textContent: p }));
    this.list.replaceChildren(...notes, ...cards);
  }

  private optionCard(opt: PackOption, layout: Layout): HTMLElement {
    const { areaX, areaY } = layout.settings;
    const cell = 6;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${areaX * cell} ${areaY * cell}`);
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("option-thumb");
    for (const b of opt.bins) {
      const r = document.createElementNS(SVG_NS, "rect");
      r.setAttribute("x", String(b.col * cell + 0.5));
      r.setAttribute("y", String(b.row * cell + 0.5));
      r.setAttribute("width", String(b.unitsX * cell - 1));
      r.setAttribute("height", String(b.unitsY * cell - 1));
      r.setAttribute("class", b.id ? (b.grownFrom ? "grown" : "fit") : "spacer");
      svg.append(r);
    }
    const binCount = opt.bins.length - opt.spacers;
    const title = `Full ${opt.rule}`;
    const stats = `${binCount} bin${binCount === 1 ? "" : "s"} · ${opt.spacers} spacer${opt.spacers === 1 ? "" : "s"}`;
    const use = Object.assign(document.createElement("button"), { type: "button", textContent: "Use this layout" });
    use.addEventListener("click", () => this.use(opt));
    const text = document.createElement("div");
    text.className = "option-text";
    text.append(
      Object.assign(document.createElement("strong"), { textContent: title }),
      Object.assign(document.createElement("span"), { className: "hint", textContent: stats }),
    );
    if (opt.left.length) {
      const name = (id: string) => layout.items.find((it) => it.id === id)?.name || "unnamed item";
      const n = opt.left.length;
      text.append(Object.assign(document.createElement("span"), {
        className: "hint bad",
        textContent: `Leaves out ${n} item${n === 1 ? "" : "s"}: ${opt.left.map((id) => `${name(id)} (${this.sizes.get(id)})`).join(", ")}`,
      }));
    }
    text.append(use);
    const card = document.createElement("div");
    card.className = "option";
    card.append(svg, text);
    return card;
  }

  private use(opt: PackOption) {
    const layout = this.hooks.layout();
    if (layout.bins.length && !confirm(`Replace the ${layout.bins.length} bin(s) on the grid with this layout? (Ctrl+Z undoes it.)`)) return;
    const items = new Map(layout.items.map((it) => [it.id, it]));
    const bins = opt.bins.map((p) => {
      const bin = newBin(p.col, p.row, p.unitsX, p.unitsY);
      const item = p.id ? items.get(p.id) : undefined;
      if (item) {
        bin.itemId = item.id;
        bin.title = (item.name || "Item") + (item.qty > 1 ? ` ×${item.qty}` : "");
      } else {
        bin.title = "Spacer";
      }
      return bin;
    });
    this.hooks.apply(bins);
  }
}
