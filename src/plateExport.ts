import type { Shape3D } from "replicad";
import type { ParamValues } from "./vendor/casefinity/models/index.ts";
import { buildParts, threeMfBlob } from "./vendor/casefinity/exports.ts";

/**
 * One print plate as a 3MF: each bin's body turned and moved to its planned
 * spot on the bed (z = 0 on the plate). Bins with lids yield extra parts; they
 * go in a separate 3MF per bin, laid out as casefinity lays them out.
 * Browser-free, so scripts/batch-test.mjs runs the same code as the worker.
 */

export interface PlateJob {
  modelId: string;
  params: ParamValues;
  name: string;
  /** Planned footprint position, mm from the bed's back-left corner (y toward the front). */
  x: number;
  y: number;
  turned: boolean;
}

export interface PlateBuild {
  plate: Uint8Array;
  extras: { name: string; bytes: Uint8Array }[];
  /** Each body's placed bounds in slicer coordinates (y toward the back): [x0, y0, z0, x1, y1, z1]. */
  bounds: number[][];
}

export function buildPlate(jobs: PlateJob[], bedY: number, title: string): PlateBuild {
  const bodies: { name: string; shape: Shape3D }[] = [];
  const extras: PlateBuild["extras"] = [];
  const bounds: number[][] = [];
  for (const job of jobs) {
    const parts = buildParts(job.modelId, job.params);
    let body = parts[0].shape;
    if (job.turned) body = body.rotate(90, [0, 0, 0], [0, 0, 1]);
    const [[x0, y0, z0], [x1, y1]] = body.boundingBox.bounds;
    // Bed-plan y runs toward the front; slicer y runs toward the back.
    const targetY = bedY - job.y - (y1 - y0);
    body = body.translate(job.x - x0, targetY - y0, -z0);
    const b = body.boundingBox.bounds;
    bounds.push([...b[0], ...b[1]]);
    bodies.push({ name: job.name, shape: body });
    if (parts.length > 1) {
      const rest = parts.slice(1);
      extras.push({ name: `${job.name}-lids`, bytes: threeMfBlob(rest, `${job.name} lids`) });
      for (const { shape } of rest) shape.delete();
    }
  }
  const plate = threeMfBlob(bodies, title);
  for (const { shape } of bodies) shape.delete();
  return { plate, extras, bounds };
}
