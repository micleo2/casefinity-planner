# Casefinity Planner

A browser-only layout planner for the [Gridfinity for Hardcases](https://www.patreon.com/UnemployedArchitect/posts/gridfinity-for-162320687)
system. Draw bins onto your case's module grid and export every part as print-ready STL / STEP / 3MF in one ZIP.
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

- **Area** — the perimeter cavity in modules. Pick a case preset (Apache 3800 → 21 × 14, Apache 4800 → 26 × 18,
  same presets as casefinity.net) or enter the case's inside length/width; modules are computed with casefinity's
  perimeter formula `floor(mm ÷ P) − border modules` (defaults 4 side / 3 front — match your perimeter). Also pitch,
  bin height, wall, clearance.
  *Advanced* holds the remaining casefinity parameters; keep the defaults for compatibility with casefinity.net.
- **Grid** — drag across empty cells to draw a bin; drag a bin to move it; drag the blue edge handles to resize.
  Top of the grid is the back (+Y) of the case, where each bin's pull tab sits.
  Keys: `R` rotate (swaps module counts — bins are handed and never mirrored), `Del` delete, arrows move,
  `Esc` deselect, `Ctrl+Z` / `Ctrl+Shift+Z` undo / redo.
- **Bin** — title (used in file names), size, type (no lid / with lid / double-sided / solid block), height
  override, lid label, hopper fillet for double-sided bins, pull tab.
- **Checks** — transport safety (every row *or* every column completely full or empty, per the guide's
  “major issue”), empty modules, print-bed fit, warp risk, rectangular double-sided hoppers.
- **Export** — one ZIP with `stl/`, optional `step/` and `3mf/`, plus `layout.json`. Identical bins are built
  once and named with a quantity, e.g. `02x02_no-lid_x4.stl`.
- The layout autosaves in the browser; *Save / Load layout* moves it between machines.

## Layout

```
src/
  bins.ts      planner state + mapping onto casefinity parameters (modulesX → widthModules, …)
  layout.ts    placement rules, checks, layout (de)serialization — pure, tested in Node
  grid.ts      SVG grid editor
  export.ts    batch build + ZIP, with a per-part cache
  step.ts      STEP writer without replicad 0.23.1's double free (see below)
  worker.ts    CAD worker (comlink): preview meshes and exports
  main.ts      UI wiring
  vendor/casefinity/   upstream models, STL/3MF writers, 3D viewer — do not edit
scripts/
  layout-test.mjs  unit tests for layout.ts / grouping
  smoke.mjs        builds each bin type with the real kernel and checks dimensions against the spec
  batch-test.mjs   builds every part of reference-layout.json in one kernel, with GC between parts
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
