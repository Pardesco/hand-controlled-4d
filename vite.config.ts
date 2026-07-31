import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative base so a production build can be opened from any sub-path
  // (or via a plain static file server) without rewriting asset URLs.
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5174,
    open: false,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
