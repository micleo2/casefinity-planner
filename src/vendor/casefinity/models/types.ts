import type { Shape3D } from "replicad";

export interface ParamDef {
  key: string;
  /** Original Fusion 360 user parameter name, for traceability */
  fusionName?: string;
  label: string;
  /** "number" (default) renders a numeric input; "text" a text input;
   *  "boolean" a checkbox. */
  type?: "number" | "text" | "boolean";
  default: number | string | boolean;
  unit?: "mm" | "deg" | "";
  min?: number;
  max?: number;
  step?: number;
  /**
   * Optional live annotation shown beside the input (e.g. a unit conversion for
   * a count expressed in modules). Gets the whole value set, so it can read
   * other params, and is re-evaluated on every edit — keep it cheap and pure.
   * A param with a hint renders with a narrowed input to leave room for it.
   */
  hint?: (p: ParamValues) => string;
}

/**
 * Parameter values keyed by ParamDef.key. Numeric params (the vast majority)
 * hold numbers; "text" and "boolean" params hold string / number (1 or 0)
 * respectively. Kept indexed as `number` so numeric models can do arithmetic
 * on `p.key` without casts — read a text/boolean param via the helpers below.
 */
export type ParamValues = Record<string, number>;

/** Safely read a "text" parameter value (stored as a string at runtime). */
export function textParam(p: ParamValues, key: string, fallback = ""): string {
  const v = (p as Record<string, unknown>)[key];
  return typeof v === "string" ? v : fallback;
}

/** Safely read a "boolean" parameter value (stored as 0 or 1). */
export function boolParam(p: ParamValues, key: string, fallback = true): boolean {
  const v = (p as Record<string, unknown>)[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return fallback;
}

/** A collapsible section of parameters in the UI form. */
export interface ParamGroup {
  /** Section heading. */
  title: string;
  /** True if the section should be collapsed by default. */
  collapsed: boolean;
  /** Param keys in display order within this section. */
  keys: string[];
}

/** A named preset that fills in a set of parameter values. */
export interface ParamPreset {
  label: string;
  values: Record<string, number | string | boolean>;
}

export interface ModelDef {
  id: string;
  name: string;
  description: string;
  params: ParamDef[];
  /** Optional collapsible groups. Params not in any group render first. */
  groups?: ParamGroup[];
  /** Optional presets dropdown. Selecting one fills in the given values. */
  presets?: ParamPreset[];
  build(p: ParamValues): Shape3D | Shape3D[];
}

export function defaultValues(model: ModelDef): ParamValues {
  return Object.fromEntries(
    model.params.map((p) => [p.key, p.default]),
  ) as unknown as ParamValues;
}