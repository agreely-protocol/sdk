import { defineConfig } from "tsup";

// Dual ESM + CJS build with full .d.ts. `undici` is the only (optional) runtime
// import and it is loaded lazily, so it is kept external — the SDK never bundles
// it, and Node 18+ users with global fetch never touch it.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "node18",
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
  external: ["undici"],
});
