import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/src/web", emptyOutDir: true },
  test: { environment: "jsdom", setupFiles: ["./test/setup.ts"] },
});
