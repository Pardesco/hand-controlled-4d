import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative base so a production build can be opened from any sub-path (or via
  // a plain static file server) without rewriting asset URLs.
  //
  // `VITE_BASE` overrides it for a deployment that lives at a known absolute
  // path -- 4d.pardesco.com serves this at `/hands/`. An absolute base is worth
  // pinning there because `./` resolves against the *document* URL, so a request
  // for `/hands` without the trailing slash would look for the MediaPipe assets
  // one directory too high.
  base: process.env.VITE_BASE ?? "./",
  server: {
    host: "127.0.0.1",
    port: 5174,
    open: false,
  },
  build: {
    target: "es2022",
    // Sourcemaps for local and standalone builds, but not for the sub-path
    // deploy: that one is the public site, the repo it is built from is public
    // too, so a 3.5 MB .map per deploy buys nothing that GitHub does not
    // already give you.
    sourcemap: !process.env.VITE_BASE,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
