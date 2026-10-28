import { DEFAULT_BOTTOM_FILLET, DEFAULT_SETTINGS, boundingBox, buildHeight, newBin } from "./bins.ts";
import type { Bin, BinType, Layout, Settings } from "./bins.ts";

/**
 * Pure layout logic: placement rules, the checks panel, and (de)serialization.
 * No DOM here, so scripts/layout-test.mjs can exercise it under Node.
 */

export interface Rect {
  col: number;
  row: number;
  modulesX: number;
  modulesY: number;
}

export function inBounds(r: Rect, s: Settings): boolean {
  return r.col >= 0 && r.row >= 0 && r.modulesX >= 1 && r.modulesY >= 1 &&
    r.col + r.modulesX <= s.areaX && r.row + r.modulesY <= s.areaY;
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.col < b.col + b.modulesX && b.col < a.col + a.modulesX &&
    a.row < b.row + b.modulesY && b.row < a.row + a.modulesY;
}

/** Whether `r` can be placed, ignoring the bin with id `ignoreId` (the one being edited). */
export function canPlace(layout: Layout, r: Rect, ignoreId?: string): boolean {
  return inBounds(r, layout.settings) &&
    layout.bins.every((b) => b.id === ignoreId || !overlaps(r, b));
}

/** Occupancy grid [row][col] → bin id, or null. Out-of-bounds bins are clipped. */
export function occupancy(layout: Layout): (string | null)[][] {
  const { areaX, areaY } = layout.settings;
  const grid: (string | null)[][] = Array.from({ length: areaY }, () => Array(areaX).fill(null));
  for (const b of layout.bins) {
    for (let r = b.row; r < Math.min(b.row + b.modulesY, areaY); r++) {
      for (let c = b.col; c < Math.min(b.col + b.modulesX, areaX); c++) grid[r][c] = b.id;
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

/** A long side past this risks lifting corners on the bed with thin 1.2 mm walls. */
export const WARP_SPAN_MM = 150;

export function warpRisk(bin: Bin, s: Settings): boolean {
  const [x, y] = boundingBox(bin, s);
  return Math.max(x, y) >= WARP_SPAN_MM;
}

export interface Check {
  ok: boolean;
  /** Warnings don't make the layout invalid; failures do. */
  level: "ok" | "warn" | "fail";
  text: string;
}

const list = (ns: number[]) => ns.map((n) => n + 1).join(", ");

export function runChecks(layout: Layout): Check[] {
  const s = layout.settings;
  const checks: Check[] = [];
  const pass = (text: string) => checks.push({ ok: true, level: "ok", text });
  const warn = (text: string) => checks.push({ ok: false, level: "warn", text });
  const fail = (text: string) => checks.push({ ok: false, level: "fail", text });

  if (layout.bins.length === 0) {
    warn("No bins yet — drag on the grid to draw one.");
    return checks;
  }

  const outside = layout.bins.filter((b) => !inBounds(b, s));
  if (outside.length) fail(`${outside.length} bin(s) extend past the area — shrink or move them.`);

  const grid = occupancy(layout);
  const rowFull = grid.map((r) => r.every(Boolean));
  const rowEmpty = grid.map((r) => r.every((c) => !c));
  const colFull = Array.from({ length: s.areaX }, (_, c) => grid.every((r) => r[c]));
  const colEmpty = Array.from({ length: s.areaX }, (_, c) => grid.every((r) => !r[c]));
  const partialRows = rowFull.flatMap((f, i) => (f || rowEmpty[i] ? [] : [i]));
  const partialCols = colFull.flatMap((f, i) => (f || colEmpty[i] ? [] : [i]));

  if (partialRows.length === 0) {
    pass("Transport-safe: no partial rows — every row is full or empty, so the bins brace wall to wall.");
  } else if (partialCols.length === 0) {
    pass("Transport-safe: no partial columns — every column is full or empty, so the bins brace wall to wall.");
  } else {
    fail(
      `Not transport-safe: partly filled rows (${list(partialRows)}) and columns (${list(partialCols)}). ` +
      "Fill whole rows or whole columns so bins can't shift.",
    );
  }

  const empty = grid.flat().filter((c) => !c).length;
  if (empty === 0) pass("All modules filled.");
  else warn(`${empty} of ${s.areaX * s.areaY} modules empty.`);

  const tooBig = layout.bins.filter((b) => !fitsBed(b, s));
  if (tooBig.length) {
    fail(`Doesn't fit the print bed: ${tooBig.map((b) => `${b.modulesX}×${b.modulesY}`).join(", ")}.`);
  } else {
    pass("Every bin fits the print bed.");
  }

  const warpy = layout.bins.filter((b) => warpRisk(b, s));
  if (warpy.length) {
    warn(`Warp risk (long side ≥ ${WARP_SPAN_MM} mm): ${warpy.map((b) => `${b.modulesX}×${b.modulesY}`).join(", ")}. Use a brim or split the bin.`);
  }

  const lopsided = layout.bins.filter((b) =>
    b.type === "double-sided" && b.modulesX !== b.modulesY && b.bottomFillet <= DEFAULT_BOTTOM_FILLET);
  if (lopsided.length) {
    warn(
      `Rectangular double-sided bin(s) ${lopsided.map((b) => `${b.modulesX}×${b.modulesY}`).join(", ")}: ` +
      "check the hopper in the preview and raise the fillet inset if it overhangs (the guide used 4.5 for 4×8).",
    );
  }

  return checks;
}

// ---- persistence -----------------------------------------------------------

export function emptyLayout(): Layout {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, bins: [] };
}

const BIN_TYPES: BinType[] = ["no-lid", "with-lid", "double-sided", "solid"];

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Parse untrusted JSON (a file or localStorage) into a valid Layout. Throws on garbage. */
export function parseLayout(json: string): Layout {
  const raw = JSON.parse(json);
  if (!raw || typeof raw !== "object" || raw.version !== 1 || !Array.isArray(raw.bins)) {
    throw new Error("Not a Casefinity Planner layout file.");
  }
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(settings) as (keyof Settings)[]) {
    settings[key] = num(raw.settings?.[key], settings[key]);
  }
  const bins: Bin[] = raw.bins.map((b: Record<string, unknown>) => {
    const base = newBin(num(b.col, 0), num(b.row, 0), Math.max(1, num(b.modulesX, 1)), Math.max(1, num(b.modulesY, 1)));
    return {
      ...base,
      id: typeof b.id === "string" && /^[a-z0-9]{1,16}$/.test(b.id) ? b.id : base.id,
      title: typeof b.title === "string" ? b.title : "",
      type: BIN_TYPES.includes(b.type as BinType) ? (b.type as BinType) : "no-lid",
      pullTab: typeof b.pullTab === "boolean" ? b.pullTab : true,
      height: typeof b.height === "number" && b.height > 0 ? b.height : null,
      lidLabel: typeof b.lidLabel === "string" ? b.lidLabel : "",
      bottomFillet: num(b.bottomFillet, DEFAULT_BOTTOM_FILLET),
    };
  });
  return { version: 1, settings, bins };
}

export function serializeLayout(layout: Layout): string {
  return JSON.stringify(layout, null, 2);
}
