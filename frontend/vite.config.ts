import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Python server serves the build from app/web. During `npm run dev`
// API calls are proxied to a pupload server running on :8080.
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
