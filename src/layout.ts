import { DEFAULT_BOTTOM_FILLET, DEFAULT_SETTINGS, boundingBox, buildHeight, newBin } from "./bins.ts";
import type { Bin, BinType, Layout, Settings } from "./bins.ts";
import { newItem, placeInBin, sizeItem } from "./sizing.ts";
import type { Item, ItemShape, Orientation } from "./sizing.ts";

/**
 * Pure layout logic: placement rules, the checks panel, and (de)serialization.
 * No DOM here, so scripts/layout-test.mjs can exercise it under Node.
 */

export interface Rect {
  col: number;
  row: number;
  unitsX: number;
  unitsY: number;
}

export function inBounds(r: Rect, s: Settings): boolean {
  return r.col >= 0 && r.row >= 0 && r.unitsX >= 1 && r.unitsY >= 1 &&
    r.col + r.unitsX <= s.areaX && r.row + r.unitsY <= s.areaY;
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.col < b.col + b.unitsX && b.col < a.col + a.unitsX &&
    a.row < b.row + b.unitsY && b.row < a.row + a.unitsY;
}

/** Whether `r` can be placed, ignoring the bin with id `ignoreId` (the one being edited). */
export function canPlace(layout: Layout, r: Rect, ignoreId?: string): boolean {
  return inBounds(r, layout.settings) &&
    layout.bins.every((b) => b.id === ignoreId || !overlaps(r, b));
}

/** The first free spot for a unitsX × unitsY bin, either way round: back row first, left to right. */
export function firstFreeSpot(layout: Layout, unitsX: number, unitsY: number): Rect | null {
  const { areaX, areaY } = layout.settings;
  for (let row = 0; row < areaY; row++) {
    for (let col = 0; col < areaX; col++) {
      for (const [ux, uy] of [[unitsX, unitsY], [unitsY, unitsX]]) {
        const r = { col, row, unitsX: ux, unitsY: uy };
        if (canPlace(layout, r)) return r;
      }
    }
  }
  return null;
}

/** Occupancy grid [row][col] → bin id, or null. Out-of-bounds bins are clipped. */
export function occupancy(layout: Layout): (string | null)[][] {
  const { areaX, areaY } = layout.settings;
  const grid: (string | null)[][] = Array.from({ length: areaY }, () => Array(areaX).fill(null));
  for (const b of layout.bins) {
    for (let r = b.row; r < Math.min(b.row + b.unitsY, areaY); r++) {
      for (let c = b.col; c < Math.min(b.col + b.unitsX, areaX); c++) grid[r][c] = b.id;
    }
  }
  return grid;
}

/** Bed fit, allowing the part to be turned 90° on the bed (it's a print, not a placement). */
export function fitsBed(bin: Bin, s: Settings): boolean {
  const [x, y] = boundingBox(bin, s);
  const flat = (x <= s.bedX && y <= s.bedY) || (y <= s.bedX && x <= s.bedY);
  return flat && buildHeight(bin, s) <= s.bedZ;
}


export interface Check {
  ok: boolean;
  /** Failures make the layout invalid; warnings need a look; info is just a note. */
  level: "ok" | "info" | "warn" | "fail";
  text: string;
}

export type Direction = "left" | "right" | "up" | "down";
const STEP: Record<Direction, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

/**
 * Groups of bins that can slide one grid unit in some direction — the
 * transport-safety test. A bin moving in a direction has to push every bin in
 * its way, and those push theirs; if that chain never reaches a case wall, the
 * whole group can shift into empty space. Only the smallest group per
 * direction is kept (a bigger one containing it adds nothing).
 */
export function slidingGroups(layout: Layout): { dir: Direction; bins: Bin[] }[] {
  const { areaX, areaY } = layout.settings;
  const grid = occupancy(layout);
  const byId = new Map(layout.bins.map((b) => [b.id, b]));
  const found: { dir: Direction; ids: Set<string> }[] = [];
  for (const dir of Object.keys(STEP) as Direction[]) {
    const [dx, dy] = STEP[dir];
    const groups: Set<string>[] = [];
    for (const start of layout.bins) {
      if (!inBounds(start, layout.settings)) continue;
      const group = new Set([start.id]);
      const queue = [start];
      let blocked = false;
      while (queue.length && !blocked) {
        const b = queue.pop()!;
        // The strip of cells just ahead of the bin's leading face
        const cells: [number, number][] = dx
          ? Array.from({ length: b.unitsY }, (_, i) => [dx > 0 ? b.col + b.unitsX : b.col - 1, b.row + i])
          : Array.from({ length: b.unitsX }, (_, i) => [b.col + i, dy > 0 ? b.row + b.unitsY : b.row - 1]);
        for (const [c, r] of cells) {
          if (c < 0 || r < 0 || c >= areaX || r >= areaY) {
            blocked = true;
            break;
          }
          const id = grid[r][c];
          if (id && !group.has(id)) {
            group.add(id);
            queue.push(byId.get(id)!);
          }
        }
      }
      if (!blocked) groups.push(group);
    }
    const minimal = groups.filter((g) => !groups.some((o) => o !== g && o.size < g.size && [...o].every((id) => g.has(id))));
    const seen = new Set<string>();
    for (const g of minimal) {
      const key = [...g].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ dir, ids: g });
    }
  }
  return found.map(({ dir, ids }) => ({ dir, bins: [...ids].map((id) => byId.get(id)!) }));
}

export function runChecks(layout: Layout): Check[] {
  const s = layout.settings;
  const checks: Check[] = [];
  const pass = (text: string) => checks.push({ ok: true, level: "ok", text });
  const info = (text: string) => checks.push({ ok: true, level: "info", text });
  const warn = (text: string) => checks.push({ ok: false, level: "warn", text });
  const fail = (text: string) => checks.push({ ok: false, level: "fail", text });

  if (layout.bins.length === 0) {
    warn("No bins yet — drag on the grid to draw one.");
    return checks;
  }

  const outside = layout.bins.filter((b) => !inBounds(b, s));
  if (outside.length) fail(`${outside.length} bin(s) extend past the area — shrink or move them.`);

  const sliding = slidingGroups(layout);
  if (sliding.length === 0) {
    pass("Transport-safe: no bin can slide.");
  } else {
    const name = (b: Bin) => `${b.title || "bin"} (${b.unitsX}×${b.unitsY})`;
    const shown = sliding.slice(0, 4).map(({ dir, bins }) =>
      `${bins.map(name).join(" + ")} can slide ${dir}`);
    fail(`Not transport-safe: ${shown.join("; ")}${sliding.length > 4 ? `; and ${sliding.length - 4} more` : ""}. ` +
      "Fill the gap so nothing can shift.");
  }

  const empty = occupancy(layout).flat().filter((c) => !c).length;
  if (empty === 0) pass("All grid units filled.");
  else info(`${empty} of ${s.areaX * s.areaY} grid units empty.`);

  const tooBig = layout.bins.filter((b) => !fitsBed(b, s));
  if (tooBig.length) {
    fail(`Doesn't fit the print bed: ${tooBig.map((b) => `${b.unitsX}×${b.unitsY}`).join(", ")}.`);
  } else {
    pass("Every bin fits the print bed.");
  }


  // casefinity sizes the double-sided hopper from the bin's width only, so a bin
  // wider than deep gets a hopper poking out through its side walls
  // (verified: a 3×2 body measures 42.4 mm deep against 31.3 mm walls).
  const wide = layout.bins.filter((b) => b.type === "double-sided" && b.unitsX > b.unitsY);
  if (wide.length) {
    fail(
      `Double-sided bin(s) ${wide.map((b) => `${b.unitsX}×${b.unitsY}`).join(", ")} are wider than deep, which casefinity's ` +
      "double-sided model can't make: the hopper sticks out through the side walls. Make them deeper than wide (e.g. 2×3) or use another type.",
    );
  }
  const deep = layout.bins.filter((b) =>
    b.type === "double-sided" && b.unitsY > b.unitsX && b.bottomFillet <= DEFAULT_BOTTOM_FILLET);
  if (deep.length) {
    warn(
      `Rectangular double-sided bin(s) ${deep.map((b) => `${b.unitsX}×${b.unitsY}`).join(", ")}: ` +
      "check the hopper in the preview and raise the fillet inset if it overhangs (the guide used 4.5 for 4×8).",
    );
  }

  const items = new Map(layout.items.map((it) => [it.id, it]));
  const offItems = new Set(layout.items.filter((it) => it.off).map((it) => it.id));
  const offBins = layout.bins.filter((b) => b.itemId && offItems.has(b.itemId));
  if (offBins.length) {
    warn(`Bin${offBins.length === 1 ? "" : "s"} for items you switched off: ${offBins.map((b) => `${b.title || "bin"} (${b.unitsX}×${b.unitsY})`).join(", ")}.`);
  }
  const cramped = layout.bins.filter((b) => {
    const item = b.itemId ? items.get(b.itemId) : undefined;
    if (!item) return false;
    const sizing = sizeItem(item, s);
    return !sizing.ok || placeInBin(item, sizing, b, s) === null;
  });
  if (cramped.length) {
    fail(`Too small for its item: ${cramped.map((b) => `${b.title || "bin"} (${b.unitsX}×${b.unitsY})`).join(", ")}.`);
  }

  return checks;
}

// ---- persistence -----------------------------------------------------------

export function emptyLayout(): Layout {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, bins: [], items: [] };
}

const BIN_TYPES: BinType[] = ["no-lid", "with-lid", "double-sided", "solid"];

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Layouts saved before the rename to grid units used the old key names. */
const RENAMED: Record<string, string> = {
  modulesX: "unitsX",
  modulesY: "unitsY",
  sideBorderModules: "sideBorderUnits",
  frontBorderModules: "frontBorderUnits",
};
function renamedKeys(obj: unknown): Record<string, unknown> {
  if (!obj || typeof obj !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [from, to] of Object.entries(RENAMED)) {
    if (from in obj) out[to] = (obj as Record<string, unknown>)[from];
  }
  return out;
}

const validId = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9]{1,16}$/.test(v);

/** Parse untrusted JSON (a file or localStorage) into a valid Layout. Throws on garbage. */
export function parseLayout(json: string): Layout {
  const raw = JSON.parse(json);
  if (!raw || typeof raw !== "object" || raw.version !== 1 || !Array.isArray(raw.bins)) {
    throw new Error("Not a Casefinity Planner layout file.");
  }
  const settings = { ...DEFAULT_SETTINGS };
  const rawSettings = { ...renamedKeys(raw.settings), ...raw.settings };
  for (const key of Object.keys(settings) as (keyof Settings)[]) {
    settings[key] = num(rawSettings[key], settings[key]);
  }
  const bins: Bin[] = raw.bins.map((raw: Record<string, unknown>) => {
    const b = { ...renamedKeys(raw), ...raw };
    const base = newBin(num(b.col, 0), num(b.row, 0), Math.max(1, num(b.unitsX, 1)), Math.max(1, num(b.unitsY, 1)));
    return {
      ...base,
      id: validId(b.id) ? b.id : base.id,
      title: typeof b.title === "string" ? b.title : "",
      type: BIN_TYPES.includes(b.type as BinType) ? (b.type as BinType) : "no-lid",
      pullTab: typeof b.pullTab === "boolean" ? b.pullTab : true,
      height: typeof b.height === "number" && b.height > 0 ? b.height : null,
      lidLabel: typeof b.lidLabel === "string" ? b.lidLabel : "",
      bottomFillet: num(b.bottomFillet, DEFAULT_BOTTOM_FILLET),
      itemId: validId(b.itemId) ? b.itemId : null,
    };
  });
  const items: Item[] = (Array.isArray(raw.items) ? raw.items : []).map((it: Record<string, unknown>) => {
    const shape: ItemShape = it.shape === "cylinder" ? "cylinder" : "box";
    const base = newItem(shape);
    const orients: Orientation[] = shape === "box" ? ["auto", "as-entered"] : ["auto", "standing", "lying"];
    return {
      ...base,
      id: validId(it.id) ? it.id : base.id,
      name: typeof it.name === "string" ? it.name.slice(0, 60) : "",
      length: num(it.length, base.length),
      width: num(it.width, base.width),
      height: num(it.height, base.height),
      diameter: num(it.diameter, base.diameter),
      qty: Math.max(1, Math.round(num(it.qty, 1))),
      orient: orients.includes(it.orient as Orientation) ? (it.orient as Orientation) : "auto",
      off: it.off === true,
    };
  });
  const known = new Set(items.map((it) => it.id));
  for (const b of bins) if (b.itemId && !known.has(b.itemId)) b.itemId = null;
  return { version: 1, settings, bins, items };
}

export function serializeLayout(layout: Layout): string {
  return JSON.stringify(layout, null, 2);
}
