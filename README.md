# Casefinity Planner

A browser-only layout planner for the [Gridfinity for Hardcases](https://www.patreon.com/UnemployedArchitect/posts/gridfinity-for-162320687)
system. Draw bins onto your case's grid and export every part as print-ready STL / STEP / 3MF in one ZIP.
Nothing is uploaded: the OpenCascade CAD kernel runs in a web worker (WASM), just like [casefinity.net](https://casefinity.net/).

Bin geometry is **casefinity's own model code**, vendored unchanged from
[agocs/casefinity](https://github.com/agocs/casefinity) (MIT) — see `src/vendor/casefinity/VENDORED.md`. Parts
from the planner therefore interlock with parts printed from casefinity.net, as long as the shared settings
(pitch, clearance, rib width/depth, wall) match.

## Use

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ — host anywhere
```

- **1 Prepare → Items** — the panel beside the grid lists what goes in the case as boxes (L × W × H) or cylinders
  (⌀ × H), with a quantity; click a row to edit it in place. Each
  gets the smallest bin it fits, standing or lying (or *as entered* / *standing* / *lying* if you choose), with
  the reasoning shown: e.g. “70 + 1 → 6 grid units give 85.9 ✓ (5 give 70.9 ✗)”. Inside sizes come from
  casefinity's geometry (`15n − 0.2 clearance − 2 × wall − socket bosses`, height − floor) and are checked
  against the real CAD model in `npm run smoke`. *Play around items* (default 1 mm) is added to each footprint.
  Each row links to the grid: *on grid* selects its bin, hovering lights it up, *+ Add bin* drops its snug bin
  into the first free spot, and the Bin card names the item a bin holds. The panel also shows the space budget
  and the tallest item a bin can take. Untick an item to switch it off: it stays in the list but auto-pack and
  the budget leave it out (and its bin, if it has one, is greyed and flagged).
- **1 Prepare → Auto-pack** — finds a transport-safe layout with full columns and one with full rows; item bins
  keep their snug size and spare grid units become spacer bins. *Use this layout* replaces the grid's bins (Ctrl+Z undoes it).
- **Preview → Whole case** — every bin as a see-through shell with its items inside in 3D. *Selected bin* shows the real CAD model of one bin.
- **2 Print** — the bins arranged onto your print bed (turned where that fits better, 5 mm gaps), each part
  numbered. *Export ZIP* gives one 3MF per plate with every body in place, a 3MF of lids for each bin that has
  them, and `layout.json`.
- **Case** — the active case is summarised at the top of the Prepare page; *Edit* opens the case
  settings (case, geometry, print bed). The case is the perimeter cavity in grid units (15 mm squares). *Case preset* starts on `--Custom--` with casefinity's default
  perimeter (350 × 250 mm → 19 × 13); pick Apache 3800 (→ 21 × 14) or Apache 4800 (→ 26 × 18), or type your case's
  inside length/width. Grid units follow casefinity's perimeter formula `floor(mm ÷ P) − border units`; the border
  units (default 4 side / 3 front, casefinity's “Side / Front border bins”) must match your perimeter.
  *Geometry* holds pitch, bin height, wall, clearance and the other casefinity parameters.
- **Grid** — drag across empty cells to draw a bin; drag a bin to move it; drag the blue edge handles to resize.
  Top of the grid is the back (+Y) of the case, where each bin's pull tab sits.
  Keys: `R` rotate (swaps the grid-unit counts — bins are handed and never mirrored), `Del` delete, arrows move,
  `Esc` deselect, `Ctrl+Z` / `Ctrl+Shift+Z` undo / redo.
- **Bin** — title (used in file names), size, type (no lid / with lid / double-sided / solid block), height
  override, lid label, hopper fillet for double-sided bins, pull tab.
- **Checks** (under the grid) — only what needs saying: failures, then warnings, then notes. Transport safety is
  exact: a layout fails if any bin, or group of bins pushing each other, can slide into empty space (named, with
  the direction); a gap boxed in so nothing can move is fine and only noted. Also print-bed fit, items that
  outgrew their bin, items switched off that still have a bin, and rectangular double-sided hoppers.
- **Export** — one ZIP with `stl/`, optional `step/` and `3mf/`, plus `layout.json`. Identical bins are built
  once and named with a quantity, e.g. `02x02_no-lid_x4.stl`.
- The layout autosaves in the browser; *Save / Load layout* moves it between machines.

## Layout

```
src/
  bins.ts      planner state + mapping onto casefinity parameters (unitsX → casefinity's widthModules, …)
  layout.ts    placement rules, checks, layout (de)serialization — pure, tested in Node
  sizing.ts    item → smallest bin, and where items sit inside a bin — pure
  pack.ts      auto-pack into full columns / rows — pure
  plates.ts    print plan: part numbers, bins → bed plates — pure
  plateExport.ts   one plate's bodies placed on the bed, as 3MF (worker and tests share it)
  itemsPanel.ts, autopack.ts, caseView.ts, printPage.ts   the Items panel, Auto-pack, whole-case 3D view, Print page
  grid.ts      SVG grid editor
  export.ts    batch build + ZIP, with a per-part cache
  step.ts      STEP writer without replicad 0.23.1's double free (see below)
  worker.ts    CAD worker (comlink): preview meshes and exports
  main.ts      UI wiring
  vendor/casefinity/   upstream models, STL/3MF writers, 3D viewer — do not edit
scripts/
  layout-test.mjs  unit tests for layout.ts / grouping
  pack-test.mjs    unit tests for sizing.ts and pack.ts
  plates-test.mjs  unit tests for plates.ts
  smoke.mjs        builds each bin type with the real kernel and checks dimensions against the spec
  batch-test.mjs   builds every part of reference-layout.json in one kernel, with GC between parts, and every
                   print plate, checking each body lands where the plan put it
  e2e.mjs          headless Chromium: draws the reference layout, edits, exports, verifies the ZIP
```

```sh
npm test                    # layout tests + smoke + batch
npm run build && npm run e2e   # needs chromium (CHROME=/path/to/chrome to override)
```

## Note: STEP export double free

replicad 0.23.1's `exportSTEP` registers its `XSControl_WorkSession` with the GC finalizer *and* hands it to a
ref-counted Handle, so it gets freed twice. A single export usually survives; a batch export crashes with
“memory access out of bounds” once the GC runs. `src/step.ts` is the same writer with the session owned by its
Handle only. `node --expose-gc scripts/batch-test.mjs --upstream-step` reproduces the crash.

## Note: double-sided bins wider than deep

casefinity sizes the double-sided hopper from the bin's width only (`ih = iw / 2` in `bin-double-sided.ts`), so a
double-sided bin wider than deep (e.g. 3 × 2) gets a hopper that sticks out through its side walls — its body
measures 42.4 mm deep against 31.3 mm walls. The Checks panel fails such bins; make them deeper than wide.
