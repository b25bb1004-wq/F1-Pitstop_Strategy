import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served from https://b25bb1004-wq.github.io/F1-Pitstop_Strategy/
export default defineConfig({
  base: "/F1-Pitstop_Strategy/",
  plugins: [react()],
  build: { target: "es2022", chunkSizeWarningLimit: 1600, sourcemap: false },
});
