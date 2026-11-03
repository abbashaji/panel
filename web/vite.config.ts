import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The Worker serves the built app under /panel/ (Workers Static Assets, same origin).
export default defineConfig({
  base: "/panel/",
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/panel/api": "http://localhost:8787" } },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
