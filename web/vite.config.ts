import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// No API proxy: it would require rewriting the existing origin/Host contract.
// Build/watch and use Bridge's same-origin listener for integrated development.
export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist/web-ui", emptyOutDir: true, assetsInlineLimit: 0 },
  server: { host: "127.0.0.1" }
});
