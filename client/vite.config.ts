import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The bundle lands next to the server bundle; `src/main.ts` serves it from there.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist/client", emptyOutDir: true },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/ws": { target: "ws://127.0.0.1:8080", ws: true },
    },
  },
});
