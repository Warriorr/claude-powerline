import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node18",
  platform: "node",
  clean: true,
  minify: true,
  nodeProtocol: true,
});
