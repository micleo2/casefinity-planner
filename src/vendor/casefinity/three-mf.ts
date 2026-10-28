import { strToU8, zipSync } from "fflate";
import type { PartMesh } from "./exports.ts";

/**
 * Minimal 3MF (3D Manufacturing Format) writer.
 *
 * A .3mf file is an OPC (Open Packaging Conventions) ZIP holding three parts:
 *   [Content_Types].xml   – declares the .model and .rels content types
 *   _rels/.rels           – points the package root at the 3D model
 *   3D/3dmodel.model      – the geometry, as core-spec XML
 *
 * Unlike STL (a single unnamed triangle soup), the 3MF core spec models each
 * body as its own <object>, and a <build> lists an <item> per object. We emit
 * one object per replicad shape, so a multi-part model (e.g. the 4 dovetailed
 * perimeter pieces) imports as separate, individually selectable parts on the
 * build plate. Coordinates are the model's own Z-up space in millimetres —
 * identical to the STL export — so z=0 sits on the plate.
 */

export interface Part {
  name: string;
  mesh: PartMesh;
}

const CORE_NS = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const MODEL_REL = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";
const MODEL_CT = "application/vnd.ms-package.3dmanufacturing-3dmodel+xml";
const RELS_CT = "application/vnd.openxmlformats-package.relationships+xml";

function xmlEscape(s: string): string {
  return s.replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!,
  );
}

/** Compact a coordinate: micron precision, never exponential notation. */
function coord(n: number): string {
  return Number(n.toFixed(4)).toString();
}

function meshXml(mesh: PartMesh): string {
  const { vertices, triangles } = mesh;
  const out: string[] = ["<mesh><vertices>"];
  for (let i = 0; i < vertices.length; i += 3) {
    out.push(
      `<vertex x="${coord(vertices[i])}" y="${coord(vertices[i + 1])}" z="${coord(vertices[i + 2])}"/>`,
    );
  }
  out.push("</vertices><triangles>");
  for (let i = 0; i < triangles.length; i += 3) {
    out.push(`<triangle v1="${triangles[i]}" v2="${triangles[i + 1]}" v3="${triangles[i + 2]}"/>`);
  }
  out.push("</triangles></mesh>");
  return out.join("");
}

/** Serialize parts into the `3D/3dmodel.model` XML document. */
export function modelXml(parts: Part[], title: string): string {
  const objects = parts
    .map(
      (part, i) =>
        `<object id="${i + 1}" type="model" name="${xmlEscape(part.name)}">${meshXml(part.mesh)}</object>`,
    )
    .join("");
  const items = parts.map((_, i) => `<item objectid="${i + 1}"/>`).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}">` +
    `<metadata name="Title">${xmlEscape(title)}</metadata>` +
    `<metadata name="Application">Hardcase Gridfinity Generator</metadata>` +
    `<resources>${objects}</resources>` +
    `<build>${items}</build>` +
    `</model>`
  );
}

/** Build a complete .3mf package (OPC ZIP) as raw bytes. */
export function build3mf(parts: Part[], title: string): Uint8Array<ArrayBuffer> {
  if (parts.length === 0) throw new Error("build3mf: no parts to export");
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Types xmlns="${CT_NS}">` +
    `<Default Extension="rels" ContentType="${RELS_CT}"/>` +
    `<Default Extension="model" ContentType="${MODEL_CT}"/>` +
    `</Types>`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Relationships xmlns="${REL_NS}">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="${MODEL_REL}"/>` +
    `</Relationships>`;
  return zipSync(
    {
      "[Content_Types].xml": strToU8(contentTypes),
      _rels: { ".rels": strToU8(rels) },
      "3D": { "3dmodel.model": strToU8(modelXml(parts, title)) },
    },
    { level: 6 },
  );
}
