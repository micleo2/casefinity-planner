import type { PartMesh } from "./exports.ts";

/**
 * Minimal binary STL writer.
 *
 * We serialize the part meshes ourselves rather than calling replicad's
 * `blobSTL()`, because that only takes a single shape: exporting several parts
 * through it means either fusing them (which welds a split liner into one body
 * — the bug this module exists to avoid) or building a `Compound`, and
 * `makeCompound` calls `delete()` on everything it is handed. replicad's
 * `clone()` returns a new wrapper around the *same* OCCT handle, so cloning
 * first does not help: the delete frees geometry the caller still holds, and the
 * kernel then faults nondeterministically.
 *
 * Writing the triangles directly sidesteps all of that, and reuses the exact
 * meshes the 3MF export writes. Layout is the standard binary STL: an 80-byte
 * header, a uint32 triangle count, then 50 bytes per triangle (3 floats of
 * normal, 3x3 floats of vertices, a uint16 attribute count). All little-endian.
 *
 * STL carries no part structure, so this is one triangle soup — but the parts
 * stay as separate closed shells, which is what lets a slicer's "split to
 * objects" pull them apart. Use 3MF if you want them named.
 */

const HEADER_BYTES = 80;
const TRIANGLE_BYTES = 50;

/** Unit normal of triangle (a, b, c); zero for a degenerate triangle. */
function normal(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): [number, number, number] {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  return len === 0 ? [0, 0, 0] : [nx / len, ny / len, nz / len];
}

/** Serialize part meshes into one binary STL file as raw bytes. */
export function buildStl(meshes: PartMesh[]): Uint8Array<ArrayBuffer> {
  if (meshes.length === 0) throw new Error("buildStl: no meshes to export");

  const count = meshes.reduce((n, m) => n + m.triangles.length / 3, 0);
  const bytes = new Uint8Array(HEADER_BYTES + 4 + count * TRIANGLE_BYTES);
  const view = new DataView(bytes.buffer);
  // The header is free-form, but must not begin with "solid" or a strict reader
  // will take the file for ASCII.
  bytes.set(new TextEncoder().encode("Casefinity binary STL").subarray(0, HEADER_BYTES));
  view.setUint32(HEADER_BYTES, count, true);

  let at = HEADER_BYTES + 4;
  for (const { vertices, triangles } of meshes) {
    for (let i = 0; i < triangles.length; i += 3) {
      const a = triangles[i] * 3, b = triangles[i + 1] * 3, c = triangles[i + 2] * 3;
      const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
      const bx = vertices[b], by = vertices[b + 1], bz = vertices[b + 2];
      const cx = vertices[c], cy = vertices[c + 1], cz = vertices[c + 2];
      const [nx, ny, nz] = normal(ax, ay, az, bx, by, bz, cx, cy, cz);
      for (const v of [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz]) {
        view.setFloat32(at, v, true);
        at += 4;
      }
      view.setUint16(at, 0, true);
      at += 2;
    }
  }
  return bytes;
}
