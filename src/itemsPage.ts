import type { Layout } from "./bins.ts";
import { newItem, sizeItem } from "./sizing.ts";
import type { Item, ItemShape, Orientation, Sizing, SizingError } from "./sizing.ts";

/**
 * The Items page: what goes in the case, as boxes and cylinders, each with the
 * smallest bin it fits and why. Rows are rebuilt only when the list's shape
 * changes (add, delete, box ↔ cylinder) so typing never loses focus; the
 * computed cells refresh on every keystroke.
 */

export interface ItemsHooks {
  layout(): Layout;
  /** Persist; `commit` records an undo step. */
  changed(commit: boolean): void;
  /** "Auto-pack →": go to the Pack page and find layouts. */
  autoPack(): void;
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

const num = (input: HTMLInputElement) => input.valueAsNumber;

export class ItemsPage {
  private selectedId: string | null = null;
  private body: HTMLTableSectionElement;
  private cells = new Map<string, { bin: HTMLElement; row: HTMLTableRowElement }>();

  constructor(private root: HTMLElement, private hooks: ItemsHooks) {
    this.body = root.querySelector("tbody")!;
    root.querySelector("#add-box")!.addEventListener("click", () => this.add("box"));
    root.querySelector("#add-cylinder")!.addEventListener("click", () => this.add("cylinder"));
    root.querySelector("#items-autopack")!.addEventListener("click", () => hooks.autoPack());
  }

  private get items(): Item[] {
    return this.hooks.layout().items;
  }

  private add(shape: ItemShape) {
    const item = newItem(shape);
    this.items.push(item);
    this.selectedId = item.id;
    this.rebuild();
    this.hooks.changed(true);
    (this.cells.get(item.id)?.row.querySelector("input") as HTMLInputElement | null)?.focus();
  }

  private remove(id: string) {
    const layout = this.hooks.layout();
    layout.items = layout.items.filter((it) => it.id !== id);
    for (const b of layout.bins) if (b.itemId === id) b.itemId = null;
    if (this.selectedId === id) this.selectedId = null;
    this.rebuild();
    this.hooks.changed(true);
  }

  /** Rebuild every row: after add/delete/shape change, load, undo. */
  rebuild() {
    this.cells.clear();
    if (!this.items.some((it) => it.id === this.selectedId)) this.selectedId = this.items[0]?.id ?? null;
    this.body.replaceChildren(...this.items.map((it) => this.row(it)));
    this.refresh();
  }

  private row(item: Item): HTMLTableRowElement {
    const commit = () => this.hooks.changed(true);
    const edit = () => {
      this.hooks.changed(false);
      this.refresh();
    };
    const numberInput = (key: "length" | "width" | "height" | "diameter" | "qty", label: string, step = "0.1") => {
      const input = el("input", { type: "number", min: key === "qty" ? "1" : "0", step: key === "qty" ? "1" : step, value: String(item[key]), className: "dim" });
      input.setAttribute("aria-label", label);
      input.title = label;
      input.addEventListener("input", () => {
        const v = num(input);
        if (Number.isFinite(v) && v >= 0) {
          item[key] = key === "qty" ? Math.max(1, Math.round(v)) : v;
          edit();
        }
      });
      input.addEventListener("change", commit);
      return input;
    };

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

    const size = el("div", { className: "dims" });
    if (item.shape === "box") {
      size.append(numberInput("length", "Length [mm]"), "×", numberInput("width", "Width [mm]"), "×", numberInput("height", "Height [mm]"));
    } else {
      size.append("⌀", numberInput("diameter", "Diameter [mm]"), "×", numberInput("height", "Height [mm]"));
    }

    const orient = el("select");
    orient.setAttribute("aria-label", "Orientation");
    for (const [value, label] of ORIENTS[item.shape]) orient.add(new Option(label, value));
    orient.value = item.orient;
    orient.addEventListener("change", () => {
      item.orient = orient.value as Orientation;
      edit();
      commit();
    });

    const bin = el("span", { className: "bin-chip" });
    const del = el("button", { type: "button", className: "ghost icon", textContent: "×", title: "Remove item" });
    del.setAttribute("aria-label", `Remove ${item.name || "item"}`);
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      this.remove(item.id);
    });

    const tr = el("tr", {},
      el("td", {}, name),
      el("td", {}, shape),
      el("td", {}, size),
      el("td", {}, numberInput("qty", "Quantity")),
      el("td", {}, orient),
      el("td", {}, bin),
      el("td", {}, del),
    );
    tr.dataset.item = item.id;
    tr.addEventListener("focusin", () => this.pick(item.id));
    tr.addEventListener("click", () => this.pick(item.id));
    this.cells.set(item.id, { bin, row: tr });
    return tr;
  }

  private pick(id: string) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.refresh();
  }

  /** Recompute bins, the explanation and the totals without touching inputs. */
  refresh() {
    const layout = this.hooks.layout();
    const s = layout.settings;
    const sized = new Map<string, Sizing | SizingError>(this.items.map((it) => [it.id, sizeItem(it, s)]));
    for (const it of this.items) {
      const cell = this.cells.get(it.id);
      if (!cell) continue;
      const r = sized.get(it.id)!;
      cell.bin.textContent = r.ok ? `${r.unitsX} × ${r.unitsY}` : "—";
      cell.bin.className = r.ok ? "bin-chip" : "bin-chip bad";
      cell.bin.title = r.ok ? "" : r.error;
      cell.row.classList.toggle("selected", it.id === this.selectedId);
    }

    const why = this.root.querySelector<HTMLElement>("#item-why")!;
    const item = this.items.find((it) => it.id === this.selectedId);
    const r = item ? sized.get(item.id)! : null;
    why.replaceChildren();
    if (!item || !r) {
      why.append(el("p", { className: "hint", textContent: "Add an item to see which bin it needs." }));
    } else if (!r.ok) {
      why.append(el("h2", { textContent: item.name || "Item" }), el("p", { className: "hint bad", textContent: r.error }));
    } else {
      why.append(
        el("h2", { textContent: `Why ${r.unitsX} × ${r.unitsY}?` }),
        el("p", { className: "why-name", textContent: item.name || "Unnamed item" }),
        ...r.explain.map((line, i) => el("p", { className: i ? "why-line" : "why-pose", textContent: line })),
        el("p", {
          className: "hint",
          textContent: `Inside of a bin n grid units wide = ${s.gridSpacing}n − ${2 * s.clear} clearance − ${2 * s.wallThick} walls` +
            (s.wallThick < 2 * s.wallBump ? ` − ${s.wallBump} socket bosses` : "") +
            `. Items get ${s.itemPlay} mm of play.`,
        }),
      );
    }

    const ok = this.items.map((it) => sized.get(it.id)!).filter((x): x is Sizing => x.ok);
    const need = ok.reduce((a, x) => a + x.unitsX * x.unitsY, 0);
    const have = s.areaX * s.areaY;
    const bad = this.items.filter((it) => !sized.get(it.id)!.ok);
    const totals = this.root.querySelector<HTMLElement>("#items-totals")!;
    totals.replaceChildren(
      el("p", {
        className: need > have ? "hint bad" : "hint",
        textContent: this.items.length === 0
          ? "No items yet."
          : `${ok.length} item${ok.length === 1 ? "" : "s"} need ${need} of ${have} grid units at minimum size.` +
            (need > have ? " That's more than the case holds." : " Auto-pack grows bins or adds spacers to fill the rest."),
      }),
      ...(bad.length ? [el("p", { className: "hint bad", textContent: `Needs fixing: ${bad.map((it) => it.name || "unnamed item").join(", ")}.` })] : []),
    );
    this.root.querySelector<HTMLButtonElement>("#items-autopack")!.disabled = ok.length === 0 || need > have;
  }
}
