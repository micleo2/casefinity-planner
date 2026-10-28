import type { ParamValues } from "./vendor/casefinity/models/index.ts";

/**
 * Planner state and its mapping onto casefinity's model parameters.
 *
 * Plan-view convention matches casefinity's bin frame: +X is to the right,
 * +Y is toward the top of the grid (the back of the case). A bin's
 * `modulesX` becomes casefinity's `widthModules` (X), `modulesY` becomes
 * `lengthModules` (Y). Bins are handed (ribs on -X/+Y, sockets on +X/-Y, pull
 * tab on +Y), so "rotating" a bin only swaps its module counts — the generated
 * part is never mirrored or turned.
 */

export type BinType = "no-lid" | "with-lid" | "double-sided" | "solid";

export const BIN_TYPES: { value: BinType; label: string; modelId: string }[] = [
  { value: "no-lid", label: "No lid", modelId: "bin-no-lid" },
  { value: "with-lid", label: "With lid", modelId: "bin-with-lid" },
  { value: "double-sided", label: "Double-sided", modelId: "bin-double-sided" },
  { value: "solid", label: "Solid block", modelId: "solid-block" },
];

/** Project-wide values. Every bin in a case must share these to interlock. */
export interface Settings {
  areaX: number; // modules
  areaY: number; // modules
  gridSpacing: number; // P, mm
  overallHeight: number; // H, mm
  wallThick: number;
  floorThick: number;
  clear: number; // c, per flank
  ribWidth: number;
  wallBump: number;
  draftAngle: number;
  pullTabHeight: number;
  /** casefinity perimeter's SIDE_BOARDER_BIN_ADD / FRONT_BOARDER_BIN_ADD: modules
   * of case length / width given up to the border on each axis. */
  sideBorderModules: number;
  frontBorderModules: number;
  bedX: number;
  bedY: number;
  bedZ: number;
}

export interface Bin {
  id: string;
  /** Grid cell of the bin's top-left corner as drawn (column, row), 0-based. */
  col: number;
  row: number;
  modulesX: number;
  modulesY: number;
  title: string;
  type: BinType;
  pullTab: boolean;
  /** Per-bin height override in mm; null uses Settings.overallHeight. */
  height: number | null;
  lidLabel: string;
  /** Double-sided only: casefinity's BOTTOM_FILLET_FACTOR. Rectangular bins
   * may need it raised so the hopper doesn't print as an overhang. */
  bottomFillet: number;
}

export interface Layout {
  version: 1;
  settings: Settings;
  bins: Bin[];
}

/** Defaults follow casefinity.net's shipped parameter defaults. */
export const DEFAULT_SETTINGS: Settings = {
  areaX: 15,
  areaY: 15,
  gridSpacing: 15,
  overallHeight: 110,
  wallThick: 1.2,
  floorThick: 1,
  clear: 0.1,
  ribWidth: 3,
  wallBump: 1.5,
  draftAngle: 2,
  pullTabHeight: 5,
  sideBorderModules: 4,
  frontBorderModules: 3,
  bedX: 256,
  bedY: 256,
  bedZ: 256,
};

/** Case interiors, copied from casefinity's perimeter model presets
 * (vendor/casefinity/models/perimeter.ts — layout-test.mjs keeps them in sync).
 * Copied rather than imported so the main bundle doesn't pull in replicad. */
export const CASE_PRESETS: { label: string; length: number; width: number; depth: number }[] = [
  { label: "Apache 3800", length: 377.825, width: 268.2875, depth: 110 },
  { label: "Apache 4800", length: 454.025, width: 323.85, depth: 125 },
];

/** Perimeter cavity in modules for a case interior dimension, using casefinity's
 * perimeter formula: floor(case / P) − border modules. Case length runs along X. */
export function cavityModules(caseMm: number, gridSpacing: number, borderModules: number): number {
  return Math.floor(caseMm / gridSpacing) - borderModules;
}

export function newBin(col: number, row: number, modulesX: number, modulesY: number): Bin {
  return {
    id: Math.random().toString(36).slice(2, 10),
    col,
    row,
    modulesX,
    modulesY,
    title: "",
    type: "no-lid",
    pullTab: true,
    height: null,
    lidLabel: "",
    bottomFillet: DEFAULT_BOTTOM_FILLET,
  };
}

/** casefinity's default BOTTOM_FILLET_FACTOR for double-sided bins. */
export const DEFAULT_BOTTOM_FILLET = 2.3;

export function modelIdFor(type: BinType): string {
  return BIN_TYPES.find((t) => t.value === type)!.modelId;
}

/** Casefinity parameter overrides for one bin; unset keys take model defaults. */
export function binParams(bin: Bin, s: Settings): ParamValues {
  const p: Record<string, number | string> = {
    widthModules: bin.modulesX,
    lengthModules: bin.modulesY,
    gridSpacing: s.gridSpacing,
    overallHeight: bin.height ?? s.overallHeight,
    wallThick: s.wallThick,
    floorThick: s.floorThick,
    clear: s.clear,
    ribWidth: s.ribWidth,
    wallBump: s.wallBump,
    draftAngle: s.draftAngle,
    pullTabHeight: bin.pullTab ? s.pullTabHeight : 0,
  };
  if (bin.type === "with-lid") p.lidLabel = bin.lidLabel || bin.title;
  if (bin.type === "double-sided") p.bottomFillet = bin.bottomFillet;
  return p as ParamValues;
}

/** Printed footprint F(n) = n·P − 2c, in mm. */
export function footprint(bin: Bin, s: Settings): [number, number] {
  return [bin.modulesX * s.gridSpacing - 2 * s.clear, bin.modulesY * s.gridSpacing - 2 * s.clear];
}

/** Plan-view bounding box: footprint plus the ribs standing proud on -X and +Y. */
export function boundingBox(bin: Bin, s: Settings): [number, number] {
  const [x, y] = footprint(bin, s);
  return [x + s.wallBump, y + s.wallBump];
}

/** Total build height including the pull tab, in mm. */
export function buildHeight(bin: Bin, s: Settings): number {
  return (bin.height ?? s.overallHeight) + (bin.pullTab ? s.pullTabHeight : 0);
}

function slug(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** File stem for a bin's exported part, e.g. "03x05_small-parts_no-lid". */
export function fileStem(bin: Bin): string {
  const size = `${String(bin.modulesX).padStart(2, "0")}x${String(bin.modulesY).padStart(2, "0")}`;
  return [size, slug(bin.title), bin.type].filter(Boolean).join("_");
}
