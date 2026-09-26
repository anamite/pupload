import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Fingerprint of the UI sources — must match tools/ui_source_hash.py, which
 * the installer uses to skip rebuilding when nothing in the UI changed.
 */
function sourceHash(root: string): string {
  const files = ["index.html", "package.json", "package-lock.json", "vite.config.ts", "tsconfig.json", "components.json"]
    .filter((f) => existsSync(path.join(root, f)));
  const walk = (dir: string): string[] =>
    readdirSync(path.join(root, dir)).flatMap((name) => {
      const rel = `${dir}/${name}`;
      return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel];
    });
  const all = [...files, ...["src", "public"].flatMap(walk)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash("sha256");
  for (const rel of all) {
    hash.update(Buffer.from(`${rel}\0`, "utf8"));
    const text = readFileSync(path.join(root, rel)).toString("latin1").replace(/\r\n/g, "\n");
    hash.update(Buffer.from(text, "latin1"));
    hash.update(Buffer.from("\0"));
  }
  return hash.digest("hex").slice(0, 16);
}

const SOURCE = sourceHash(__dirname);
const VERSION = JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf8")).version as string;

/** Writes build-info.json so open pages can notice an update and the installer can skip rebuilds. */
function buildInfo(): Plugin {
  return {
    name: "pupload-build-info",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "build-info.json",
        source: JSON.stringify({ source: SOURCE, version: VERSION }, null, 2) + "\n",
      });
    },
  };
}

// The Python server serves the build from app/web. During `npm run dev`
// API calls are proxied to a pupload server running on :8080.
export default defineConfig({
  plugins: [react(), tailwindcss(), buildInfo()],
  define: { __BUILD_ID__: JSON.stringify(SOURCE) },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  build: {
    outDir: path.resolve(__dirname, "../app/web"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
  },
  server: {
    host: true,
    proxy: { "/api": "http://127.0.0.1:8080" },
  },
});
