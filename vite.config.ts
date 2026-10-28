import { defineConfig } from "vite";

export default defineConfig({
  // The OCCT WASM loader confuses esbuild's dependency pre-bundling
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
  worker: { format: "es" },
});
