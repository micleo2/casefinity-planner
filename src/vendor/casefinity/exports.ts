import { exportSTEP } from "replicad";
import type { Shape3D } from "replicad";
import { modelById, defaultValues } from "./models/index.ts";
import type { ParamValues } from "./models/index.ts";
import { build3mf } from "./three-mf.ts";
import { buildStl } from "./stl.ts";

/**
 * Turning a built model into a downloadable file, one function per format.
 *
 * This lives outside the worker so the export path is the *same code* the
 * headless checks run (`scripts/check-exports.mjs`) — the worker is only a
 * comlink wrapper around it. It must therefore stay free of browser-only APIs,
 * and its `src/models/` imports carry explicit `.ts` extensions so Node's type
 * stripping can resolve them.
 *
 * A model's `build()` may return several shapes: the dovetailed perimeter
 * pieces, a bin body plus its lids.
 */

/** A triangle mesh as produced by replicad's `Shape3D.mesh()`. */
export interface PartMesh {
  /** Flat [x,y,z, x,y,z, …] vertex coordinates. */
  vertices: number[];
  /** Flat vertex-index triples, one per triangle. */
  triangles: number[];
}

/** One build shape and the name it carries into the exported file. */
export interface NamedPart {
  name: string;
  shape: Shape3D;
}

/** Mesh every part once, at the tolerance both the STL and 3MF exports use. */
function meshParts(parts: NamedPart[]): PartMesh[] {
  return parts.map(({ shape }) => shape.mesh({ tolerance: 0.01, angularTolerance: 30 }));
}

/**
 * Name the parts of a model: the model id for a single body, else
 * `<id>-part-1`, `<id>-part-2`, … so each part is identifiable downstream.
 */
export function partNames(modelId: string, count: number): string[] {
  if (count === 1) return [modelId];
  return Array.from({ length: count }, (_, i) => `${modelId}-part-${i + 1}`);
}

/** Build a model and pair each of its shapes with its part name. */
export function buildParts(modelId: string, params: ParamValues): NamedPart[] {
  const model = modelById(modelId);
  const values = { ...defaultValues(model), ...params };
  const result = model.build(values);
  const shapes = Array.isArray(result) ? result : [result];
  const names = partNames(modelId, shapes.length);
  return shapes.map((shape, i) => ({ name: names[i], shape }));
}

function requireParts(parts: NamedPart[]): NamedPart[] {
  if (parts.length === 0) throw new Error("export: model produced no shapes");
  return parts;
}

/**
 * STEP, as an XCAF assembly with one named product per part.
 *
 * The parts are NOT fused. They touch — the perimeter's seam bulkheads butt
 * face-to-face, and only the dovetail flanks carry `dovetailClear` — so a
 * boolean union welds them into one solid and merges the now-coplanar seam
 * faces, which is what used to make a split liner open in CAD as a single body
 * with no seams.
 *
 * replicad hardcodes `write.step.assembly = 2`, so this is a product assembly
 * (a root plus one component per part) rather than one product holding several
 * solids. Onshape's import dialog offers a "flatten" option that drops every
 * part into a single Part Studio in assembly position.
 */
export function stepBlob(parts: NamedPart[]): Blob {
  // `NamedPart` is structurally a replicad `ShapeConfig` already.
  return exportSTEP(requireParts(parts));
}

/**
 * STL, as one triangle soup of disjoint closed shells.
 *
 * STL has no notion of a part, so this is one unnamed soup — but leaving the
 * parts unfused keeps them as separate closed shells, which is what
 * lets a slicer's "split to objects" pull them apart, and what stops a bin's lid
 * being welded to its body. Use 3MF if you want them named.
 *
 * See `stl.ts` for why the triangles are written directly instead of going
 * through replicad's single-shape `blobSTL()`.
 */
export function stlBlob(parts: NamedPart[]): Blob {
  const bytes = buildStl(meshParts(requireParts(parts)));
  return new Blob([bytes], { type: "model/stl" });
}

export function threeMfBlob(parts: NamedPart[], title: string): Uint8Array<ArrayBuffer> {
  const meshes = meshParts(requireParts(parts));
  return build3mf(
    parts.map(({ name }, i) => ({ name, mesh: meshes[i] })),
    title,
  );
}
