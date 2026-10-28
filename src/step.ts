import { createAssembly, getOC } from "replicad";
import type { NamedPart } from "./vendor/casefinity/exports.ts";

/**
 * STEP export, equivalent to replicad 0.23.1's `exportSTEP` (which casefinity's
 * `stepBlob` wraps) minus its double free.
 *
 * Upstream registers the raw `XSControl_WorkSession` with replicad's GC
 * FinalizationRegistry *and* hands it to a reference-counted Handle. Once the
 * writer and the handle are finalized the refcount drops to zero and OCCT
 * frees the session; the registry then deletes it a second time. One export
 * per page load rarely notices, but a batch export lets the GC run between
 * parts and the corrupted heap surfaces as "memory access out of bounds" a
 * few parts later (reproduced by scripts/batch-test.mjs --upstream-step).
 *
 * Here the session is owned by its Handle alone and everything is released
 * synchronously, so no finalizer ever touches it.
 */
export function stepBytes(parts: NamedPart[]): Uint8Array {
  if (parts.length === 0) throw new Error("export: model produced no shapes");
  const oc = getOC();
  const doc = createAssembly(parts);
  const session = new oc.Handle_XSControl_WorkSession_2(new oc.XSControl_WorkSession());
  const writer = new oc.STEPCAFControl_Writer_2(session, false);
  const progress = new oc.Message_ProgressRange_1();
  const filename = "export.step";
  try {
    writer.SetColorMode(true);
    writer.SetLayerMode(true);
    writer.SetNameMode(true);
    oc.Interface_Static.SetIVal("write.surfacecurve.mode", true as unknown as number);
    oc.Interface_Static.SetIVal("write.precision.mode", 0);
    oc.Interface_Static.SetIVal("write.step.assembly", 2);
    oc.Interface_Static.SetIVal("write.step.schema", 5);
    // As upstream, this handle is never released: it pins the document's
    // refcount so only `doc.delete()` below frees it.
    writer.Transfer_1(
      new oc.Handle_TDocStd_Document_2(doc.wrapped),
      // @ts-expect-error the generated typings don't model this enum
      oc.STEPControl_StepModelType.STEPControl_AsIs,
      null,
      progress,
    );
    if (writer.Write(filename) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
      throw new Error("Writing the STEP file failed.");
    }
    const bytes = oc.FS.readFile("/" + filename) as Uint8Array;
    oc.FS.unlink("/" + filename);
    return bytes;
  } finally {
    progress.delete();
    writer.delete();
    session.delete(); // last reference: frees the work session
    doc.delete();
  }
}
