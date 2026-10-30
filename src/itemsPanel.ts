import { newBin } from "./bins.ts";
import type { Layout } from "./bins.ts";
import { firstFreeSpot } from "./layout.ts";
import { insideHeight, newItem, sizeItem } from "./sizing.ts";
import type { Item, ItemShape, Orientation, Sizing, SizingError } from "./sizing.ts";

/**
 * The Items panel on the Pack page: what goes in the case, each item's
 * smallest bin, and its link to the grid. A row shows the item's bin size and
 * whether it's on the grid (click to select that bin) or not (+ Add bin puts
 * its snug bin in the first free spot); hovering a row lights up its bins.
 * Clicking a row opens it for editing in place. Rows are rebuilt only when the
 * list's shape changes (add, delete, box ↔ cylinder) so typing never loses
 * focus; the computed parts refresh on every render.
 */

export interface ItemsPanelHooks {
  layout(): Layout;
  /** Persist; `commit` records an undo step. */
  changed(commit: boolean): void;
  selectedBinId(): string | null;
  selectBin(id: string | null): void;
  /** Light up this item's bins on the grid (null clears). */
  highlight(itemId: string | null): void;
}

const ORIENTS: Record<ItemShape, [Orientation, string][]> = {
  box: [["auto", "Auto — smallest bin"], ["as-entered", "As entered (H up)"]],
  cylinder: [["auto", "Auto — smallest bin"], ["standing", "Standing"], ["lying", "Lying down"]],
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & Record<string, unknown> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

interface RowParts {
  row: HTMLElement;
  name: HTMLElement;
  chip: HTMLElement;
  status: HTMLElement;
  why: HTMLElement;
}

export class ItemsPanel {
  /** The item open for editing. */
  private openId: string | null = null;
  private list: HTMLElement;
  private rows = new Map<string, RowParts>();

  constructor(private root: HTMLElement, private hooks: ItemsPanelHooks) {
    this.list = root.querySelector("#item-list")!;
    root.querySelector("#add-box")!.addEventListener("click", () => this.add("box"));
    root.querySelector("#add-cylinder")!.addEventListener("click", () => this.add("cylinder"));
    this.list.addEventListener("mouseleave", () => hooks.highlight(null));
  }

  private get items(): Item[] {
    return this.hooks.layout().items;
  }

  /** Open an item for editing and bring it into view (from the Bin card). */
  open(id: string) {
    this.openId = id;
    this.refresh();
    this.rows.get(id)?.row.scrollIntoView({ block: "nearest" });
  }

  private add(shape: ItemShape) {
    const item = newItem(shape);
    this.items.push(item);
    this.openId = item.id;
    this.rebuild();
    this.hooks.changed(true);
    this.rows.get(item.id)?.row.querySelector<HTMLInputElement>(".item-editor input")?.focus();
  }

  private remove(id: string) {
    const layout = this.hooks.layout();
    const item = layout.items.find((it) => it.id === id);
    const bins = layout.bins.filter((b) => b.itemId === id);
    const name = item?.name || "this item";
    if (bins.length && !confirm(`Remove ${name}? Its bin stays on the grid as an empty bin.`)) return;
    layout.items = layout.items.filter((it) => it.id !== id);
    for (const b of bins) b.itemId = null;
    if (this.openId === id) this.openId = null;
    this.rebuild();
    this.hooks.changed(true);
  }

  /** Its snug bin in the first free spot, linked and selected. */
  private addBin(item: Item) {
    const layout = this.hooks.layout();
    const r = sizeItem(item, layout.settings);
    if (!r.ok) return;
    const spot = firstFreeSpot(layout, r.unitsX, r.unitsY);
    const parts = this.rows.get(item.id);
    if (!spot) {
      if (parts) parts.status.replaceChildren(el("span", { className: "bad", textContent: `No free ${r.unitsX}×${r.unitsY} spot` }));
      return;
    }
    const bin = newBin(spot.col, spot.row, spot.unitsX, spot.unitsY);
    bin.itemId = item.id;
    bin.title = (item.name || "Item") + (item.qty > 1 ? ` ×${item.qty}` : "");
    layout.bins.push(bin);
    this.hooks.changed(true);
    this.hooks.selectBin(bin.id);
  }

  /** Rebuild every row: after add/delete/shape change, load, undo. */
  rebuild() {
    this.rows.clear();
    if (!this.items.some((it) => it.id === this.openId)) this.openId = null;
    this.list.replaceChildren(...this.items.map((it) => this.row(it)));
    this.refresh();
  }

  private row(item: Item): HTMLElement {
    const commit = () => this.hooks.changed(true);
    const edit = () => this.hooks.changed(false);
    const numberInput = (key: "length" | "width" | "height" | "diameter" | "qty", label: string) => {
      const input = el("input", {
        type: "number", min: key === "qty" ? "1" : "0", step: key === "qty" ? "1" : "0.1",
        value: String(item[key]), className: key === "qty" ? "qty" : "dim",
      });
      input.setAttribute("aria-label", label);
      input.title = label;
      input.addEventListener("input", () => {
        const v = input.valueAsNumber;
        if (Number.isFinite(v) && v >= 0) {
          item[key] = key === "qty" ? Math.max(1, Math.round(v)) : v;
          edit();
        }
      });
      input.addEventListener("change", commit);
      return input;
    };

    // Summary line: caret, name, bin size, grid status
    const caret = el("span", { className: "caret", textContent: "▸" });
    const nameText = el("span", { className: "item-name" });
    const chip = el("span", { className: "bin-chip" });
    const status = el("span", { className: "item-status" });
    const head = el("div", { className: "item-head" }, caret, nameText, chip, status);
    head.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      this.openId = this.openId === item.id ? null : item.id;
      const bin = this.hooks.layout().bins.find((b) => b.itemId === item.id);
      if (bin && this.openId) this.hooks.selectBin(bin.id);
      else this.refresh();
    });

    // Editor
    const name = el("input", { type: "text", value: item.name, placeholder: item.shape === "box" ? "e.g. Bit set" : "e.g. Solder spool", maxLength: 60 });
    name.setAttribute("aria-label", "Item name");
    name.addEventListener("input", () => {
      item.name = name.value;
      edit();
    });
    name.addEventListener("change", commit);

    const shape = el("select");
    shape.setAttribute("aria-label", "Shape");
    shape.add(new Option("Box", "box"));
    shape.add(new Option("Cylinder", "cylinder"));
    shape.value = item.shape;
    shape.addEventListener("change", () => {
      const next = shape.value as ItemShape;
      const fresh = newItem(next);
      Object.assign(item, {
        shape: next,
        orient: "auto",
        diameter: next === "cylinder" ? item.diameter || fresh.diameter : item.diameter,
        length: next === "box" ? item.length || fresh.length : item.length,
        width: next === "box" ? item.width || fresh.width : item.width,
      });
      this.rebuild();
      commit();
    });

    const dims = el("div", { className: "dims" });
    if (item.shape === "box") {
      dims.append(numberInput("length", "Length [mm]"), "×", numberInput("width", "Width [mm]"), "×", numberInput("height", "Height [mm]"));
    } else {
      dims.append("⌀", numberInput("diameter", "Diameter [mm]"), "×", numberInput("height", "Height [mm]"));
    }

    const orient = el("select");
    orient.setAttribute("aria-label", "Orientation");
    for (const [value, label] of ORIENTS[item.shape]) orient.add(new Option(label, value));
    orient.value = item.orient;
    orient.addEventListener("change", () => {
      item.orient = orient.value as Orientation;
      commit();
    });

    const del = el("button", { type: "button", className: "danger", textContent: "Remove item" });
    del.addEventListener("click", () => this.remove(item.id));

    const why = el("div", { className: "why" });
    const editor = el("div", { className: "item-editor" },
      el("div", { className: "item-fields" }, name),
      el("div", { className: "item-fields" }, shape, dims),
      el("div", { className: "item-fields" }, el("label", { className: "inline" }, "Qty", numberInput("qty", "Quantity")), orient),
      why,
      el("div", { className: "buttons" }, del),
    );

    const row = el("div", { className: "item-row" }, head, editor);
    row.dataset.item = item.id;
    row.addEventListener("mouseenter", () => this.hooks.highlight(item.id));
    this.rows.set(item.id, { row, name: nameText, chip, status, why });
    return row;
  }

  /** Recompute sizes, statuses, explanations and the budget without touching inputs. */
  refresh() {
    const layout = this.hooks.layout();
    const s = layout.settings;
    const sized = new Map<string, Sizing | SizingError>(this.items.map((it) => [it.id, sizeItem(it, s)]));
    const selectedBin = layout.bins.find((b) => b.id === this.hooks.selectedBinId());
    let placed = 0;
    for (const it of this.items) {
      const parts = this.rows.get(it.id);
      if (!parts) continue;
      const r = sized.get(it.id)!;
      const bin = layout.bins.find((b) => b.itemId === it.id);
      if (bin) placed++;
      parts.name.textContent = it.name || "Unnamed item";
      parts.chip.textContent = r.ok ? `${r.unitsX}×${r.unitsY}` : "—";
      parts.chip.className = r.ok ? "bin-chip" : "bin-chip bad";
      parts.chip.title = r.ok ? "Smallest bin, in grid units" : r.error;
      if (!r.ok) {
        parts.status.replaceChildren(el("span", { className: "bad", textContent: "fix size" }));
      } else if (bin) {
        const go = el("button", { type: "button", className: "linklike", textContent: "on grid" });
        go.title = "Select its bin";
        go.addEventListener("click", () => this.hooks.selectBin(bin.id));
        parts.status.replaceChildren(go);
      } else {
        const add = el("button", { type: "button", className: "add-bin", textContent: "+ Add bin" });
        add.title = "Put its bin in the first free spot on the grid";
        add.addEventListener("click", () => this.addBin(it));
        parts.status.replaceChildren(add);
      }
      const open = it.id === this.openId;
      parts.row.classList.toggle("open", open);
      parts.row.classList.toggle("linked", !!selectedBin && selectedBin.itemId === it.id);
      (parts.row.querySelector(".caret") as HTMLElement).textContent = open ? "▾" : "▸";
      parts.why.replaceChildren(
        ...(r.ok
          ? r.explain.map((line, i) => el("p", { className: i ? "why-line" : "why-pose", textContent: line }))
          : [el("p", { className: "hint bad", textContent: r.error })]),
      );
    }

    // Counts, the space budget and the height limit
    const ok = this.items.map((it) => sized.get(it.id)!).filter((x): x is Sizing => x.ok);
    const need = ok.reduce((a, x) => a + x.unitsX * x.unitsY, 0);
    const have = s.areaX * s.areaY;
    const n = this.items.length;
    this.root.querySelector("#items-count")!.textContent = n ? `${placed} of ${n} on the grid` : "";
    const budget = this.root.querySelector<HTMLElement>("#items-budget")!;
    budget.hidden = n === 0;
    const pct = have ? Math.round((need / have) * 100) : 0;
    budget.querySelector(".budget-text")!.textContent = `Items need ${need} of ${have} grid units (${pct}%)`;
    const fill = budget.querySelector<HTMLElement>(".budget-bar span")!;
    fill.style.width = `${Math.min(100, pct)}%`;
    budget.classList.toggle("over", need > have);
    this.root.querySelector("#items-height")!.textContent =
      `Items can be up to ${+insideHeight(s).toFixed(1)} mm tall (bin height ${s.overallHeight} − ${s.floorThick} mm floor).`;
    this.root.querySelector<HTMLElement>("#items-empty")!.hidden = n > 0;
  }
}
