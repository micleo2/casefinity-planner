import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages serves the site under /<repo>/; the deploy workflow sets BASE_PATH
  base: process.env.BASE_PATH ?? "/",
  // The OCCT WASM loader confuses esbuild's dependency pre-bundling
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
  worker: { format: "es" },
});
