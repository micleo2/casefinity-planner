import { isSpacer } from "./bins.ts";
import type { Bin, Layout } from "./bins.ts";
import { canPlace, fitsBed, inBounds } from "./layout.ts";
import { placeInBin, sizeItem } from "./sizing.ts";
import type { Rect } from "./layout.ts";

/**
 * The plan-view grid editor. Row 1 is at the top of the screen, which is the
 * +Y (back) side of the case — so the pull tab, which casefinity puts on the
 * bin's +Y wall, is drawn on a bin's top edge.
 *
 * Drag on empty cells to draw a bin, drag a bin to move it, drag the edge
 * handles of the selected bin to resize it. Moves and resizes only ever land
 * on a valid placement: an invalid candidate leaves the bin where it last fit.
 */

const CELL = 32;
const MARGIN = 26;
const SVG_NS = "http://www.w3.org/2000/svg";

type Edge = "left" | "right" | "top" | "bottom";

type Drag =
  | { mode: "draw"; anchorCol: number; anchorRow: number; rect: Rect; pointerId: number }
  | { mode: "move"; bin: Bin; dCol: number; dRow: number; start: Rect; moved: boolean; pointerId: number }
  | { mode: "resize"; bin: Bin; edge: Edge; start: Rect; pointerId: number };

export interface GridHooks {
  layout(): Layout;
  selectedId(): string | null;
  /** Bins holding this item are lit up (its row is hovered in the Items panel). */
  linkedItem(): string | null;
  select(id: string | null): void;
  create(rect: Rect): void;
  /** A bin's position/size was changed live; `done` marks the end of the gesture. */
  changed(done: boolean): void;
}

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  text?: string,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

const rectOf = (b: Rect): Rect => ({ col: b.col, row: b.row, unitsX: b.unitsX, unitsY: b.unitsY });

export class GridEditor {
  private drag: Drag | null = null;

  constructor(private svg: SVGSVGElement, private hooks: GridHooks) {
    svg.addEventListener("pointerdown", (e) => this.onDown(e));
    svg.addEventListener("pointermove", (e) => this.onMove(e));
    svg.addEventListener("pointerup", (e) => this.onUp(e));
    svg.addEventListener("pointercancel", (e) => this.onUp(e, true));
  }

  /** Cell under the pointer, unclamped (may be outside the area). */
  private cellAt(e: PointerEvent): [number, number] {
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(this.svg.getScreenCTM()!.inverse());
    return [Math.floor((pt.x - MARGIN) / CELL), Math.floor((pt.y - MARGIN) / CELL)];
  }

  private clampCell([c, r]: [number, number]): [number, number] {
    const { areaX, areaY } = this.hooks.layout().settings;
    return [Math.max(0, Math.min(areaX - 1, c)), Math.max(0, Math.min(areaY - 1, r))];
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as Element;
    const layout = this.hooks.layout();
    const binEl = target.closest<SVGGElement>("[data-bin]");
    const handle = target.getAttribute("data-edge") as Edge | null;
    const bin = binEl ? layout.bins.find((b) => b.id === binEl.dataset.bin) : undefined;
    const [c, r] = this.cellAt(e);

    if (bin && handle) {
      this.drag = { mode: "resize", bin, edge: handle, start: rectOf(bin), pointerId: e.pointerId };
    } else if (bin) {
      this.hooks.select(bin.id);
      this.drag = { mode: "move", bin, dCol: c - bin.col, dRow: r - bin.row, start: rectOf(bin), moved: false, pointerId: e.pointerId };
    } else {
      const { areaX, areaY } = layout.settings;
      if (c < 0 || r < 0 || c >= areaX || r >= areaY) {
        this.hooks.select(null);
        return;
      }
      const rect = { col: c, row: r, unitsX: 1, unitsY: 1 };
      this.drag = { mode: "draw", anchorCol: c, anchorRow: r, rect, pointerId: e.pointerId };
    }
    this.svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    this.render();
  }

  private onMove(e: PointerEvent) {
    const d = this.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    const layout = this.hooks.layout();

    if (d.mode === "draw") {
      const [c, r] = this.clampCell(this.cellAt(e));
      d.rect = {
        col: Math.min(c, d.anchorCol),
        row: Math.min(r, d.anchorRow),
        unitsX: Math.abs(c - d.anchorCol) + 1,
        unitsY: Math.abs(r - d.anchorRow) + 1,
      };
      this.render();
      return;
    }

    const [c, r] = this.cellAt(e);
    let cand: Rect;
    if (d.mode === "move") {
      cand = { ...rectOf(d.bin), col: c - d.dCol, row: r - d.dRow };
    } else {
      const s = d.start;
      const right = s.col + s.unitsX; // exclusive
      const bottom = s.row + s.unitsY;
      cand = { ...s };
      if (d.edge === "left") { const col = Math.min(c, right - 1); cand.col = col; cand.unitsX = right - col; }
      if (d.edge === "right") cand.unitsX = Math.max(1, c - s.col + 1);
      if (d.edge === "top") { const row = Math.min(r, bottom - 1); cand.row = row; cand.unitsY = bottom - row; }
      if (d.edge === "bottom") cand.unitsY = Math.max(1, r - s.row + 1);
    }
    const cur = rectOf(d.bin);
    const same = cand.col === cur.col && cand.row === cur.row && cand.unitsX === cur.unitsX && cand.unitsY === cur.unitsY;
    if (!same && canPlace(layout, cand, d.bin.id)) {
      Object.assign(d.bin, cand);
      if (d.mode === "move") d.moved = true;
      this.hooks.changed(false);
    }
  }

  private onUp(e: PointerEvent, cancelled = false) {
    const d = this.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    this.drag = null;
    if (d.mode === "draw") {
      if (!cancelled && canPlace(this.hooks.layout(), d.rect)) this.hooks.create(d.rect);
      else this.render();
      return;
    }
    if (cancelled) Object.assign(d.bin, d.start);
    const s = d.start;
    const b = d.bin;
    const changed = b.col !== s.col || b.row !== s.row || b.unitsX !== s.unitsX || b.unitsY !== s.unitsY;
    if (changed || cancelled) this.hooks.changed(true);
    else this.render();
  }

  /**
   * The item's footprint inside its bin, to scale: where placeInBin puts each
   * copy (bin-local mm, +Y = back = up on screen). Boxes are rectangles,
   * standing cylinders circles, and lying cylinders — a rectangle from above —
   * are shaded like a roll (dark rims, light down the axis).
   */
  private drawItems(g: SVGGElement, b: Bin, layout: Layout, cx: number, cy: number) {
    const item = b.itemId ? layout.items.find((it) => it.id === b.itemId) : undefined;
    if (!item) return;
    const s = layout.settings;
    const sizing = sizeItem(item, s);
    const solids = sizing.ok ? placeInBin(item, sizing, b, s) : null;
    if (!solids) return;
    const k = CELL / s.gridSpacing;
    for (const so of solids) {
      const px = cx + so.cx * k;
      const py = cy - so.cy * k;
      if (so.kind === "cyl" && so.axis === "z") {
        g.append(el("circle", { class: "item-fp", cx: px, cy: py, r: so.r * k }));
        continue;
      }
      const [sx, sy] = so.kind === "box" ? [so.sx, so.sy] : so.axis === "x" ? [so.len, 2 * so.r] : [2 * so.r, so.len];
      const rect = el("rect", { class: "item-fp", x: px - (sx * k) / 2, y: py - (sy * k) / 2, width: sx * k, height: sy * k, rx: 1.5 });
      if (so.kind === "cyl") rect.style.fill = `url(#roll-${so.axis})`;
      g.append(rect);
    }
  }

  render() {
    const layout = this.hooks.layout();
    const { areaX, areaY } = layout.settings;
    const s = layout.settings;
    const selected = this.hooks.selectedId();
    const svg = this.svg;
    const W = areaX * CELL;
    const H = areaY * CELL;
    svg.replaceChildren();
    svg.setAttribute("viewBox", `0 0 ${W + 2 * MARGIN} ${H + 2 * MARGIN}`);

    // Roll shading for lying cylinders: dark at both rims, light along the axis
    const defs = el("defs", {});
    for (const axis of ["x", "y"]) {
      const grad = el("linearGradient", { id: `roll-${axis}`, x1: 0, y1: 0, x2: axis === "x" ? 0 : 1, y2: axis === "x" ? 1 : 0 });
      for (const [offset, color, opacity] of [[0, "#b07d22", 0.75], [0.45, "#f3dfb2", 0.55], [1, "#b07d22", 0.75]] as const) {
        grad.append(el("stop", { offset, "stop-color": color, "stop-opacity": opacity }));
      }
      defs.append(grad);
    }
    svg.append(defs);
    svg.append(el("rect", { class: "area", x: MARGIN, y: MARGIN, width: W, height: H }));
    const lines = el("path", {
      class: "cell",
      d: [
        ...Array.from({ length: areaX - 1 }, (_, i) => `M${MARGIN + (i + 1) * CELL} ${MARGIN}v${H}`),
        ...Array.from({ length: areaY - 1 }, (_, i) => `M${MARGIN} ${MARGIN + (i + 1) * CELL}h${W}`),
      ].join(""),
    });
    svg.append(lines);
    for (let c = 0; c < areaX; c++) {
      const x = MARGIN + (c + 0.5) * CELL;
      svg.append(el("text", { class: "axis", x, y: MARGIN / 2 }, String(c + 1)));
      svg.append(el("text", { class: "axis", x, y: MARGIN * 1.5 + H }, String(c + 1)));
    }
    for (let r = 0; r < areaY; r++) {
      const y = MARGIN + (r + 0.5) * CELL;
      svg.append(el("text", { class: "axis", x: MARGIN / 2, y }, String(r + 1)));
      svg.append(el("text", { class: "axis", x: MARGIN * 1.5 + W, y }, String(r + 1)));
    }

    // Selected bin last so its handles sit above its neighbours
    const bins = [...layout.bins].sort((a, b) => Number(a.id === selected) - Number(b.id === selected));
    for (const b of bins) {
      const x = MARGIN + b.col * CELL;
      const y = MARGIN + b.row * CELL;
      const w = b.unitsX * CELL;
      const h = b.unitsY * CELL;
      const isSel = b.id === selected;
      const bad = !inBounds(b, s) || !fitsBed(b, s);
      const linked = !!b.itemId && b.itemId === this.hooks.linkedItem();
      const itemOff = !!b.itemId && !!layout.items.find((it) => it.id === b.itemId)?.off;
      const g = el("g", { class: `bin${isSpacer(b) ? " spacer" : ""}${linked ? " linked" : ""}${itemOff ? " item-off" : ""}${isSel ? " selected" : ""}${bad ? " invalid" : ""}`, "data-bin": b.id });
      g.append(el("rect", { class: "body", x: x + 1.5, y: y + 1.5, width: w - 3, height: h - 3, rx: 3 }));
      this.drawItems(g, b, layout, x + w / 2, y + h / 2);
      const label = el("text", { class: "label", x: x + w / 2, y: y + h / 2 }, `${b.unitsX}×${b.unitsY}`);
      g.append(label);
      if (b.title && !isSpacer(b) && h >= 2 * CELL) {
        const t = b.title.length > w / 7 ? `${b.title.slice(0, Math.max(1, Math.floor(w / 7) - 1))}…` : b.title;
        g.append(el("text", { class: "title", x: x + w / 2, y: y + h / 2 + 16 }, t));
      }
      if (!fitsBed(b, s)) g.append(el("text", { class: "icons", x: x + w - 5, y: y + h - 8 }, "⛔"));
      if (isSel) {
        const hs = 8;
        const handles: [Edge, number, number][] = [
          ["top", x + w / 2, y + 1.5],
          ["bottom", x + w / 2, y + h - 1.5],
          ["left", x + 1.5, y + h / 2],
          ["right", x + w - 1.5, y + h / 2],
        ];
        for (const [edge, hx, hy] of handles) {
          g.append(el("rect", { class: `handle ${edge}`, "data-edge": edge, x: hx - hs / 2, y: hy - hs / 2, width: hs, height: hs }));
        }
      }
      svg.append(g);
    }

    if (this.drag?.mode === "draw") {
      const r = this.drag.rect;
      const ok = canPlace(layout, r);
      svg.append(el("rect", {
        class: `ghost${ok ? "" : " invalid"}`,
        x: MARGIN + r.col * CELL + 1.5,
        y: MARGIN + r.row * CELL + 1.5,
        width: r.unitsX * CELL - 3,
        height: r.unitsY * CELL - 3,
        rx: 3,
      }));
      svg.append(el("text", {
        class: "ghost-label",
        x: MARGIN + (r.col + r.unitsX / 2) * CELL,
        y: MARGIN + (r.row + r.unitsY / 2) * CELL,
      }, `${r.unitsX}×${r.unitsY}`));
    }
  }
}
