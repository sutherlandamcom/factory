import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const host = process.env.FACTORY_OPERATOR_HOST || "localhost";
const port = Number(process.env.FACTORY_OPERATOR_PORT || 5173);
const target = process.env.FACTORY_OPERATOR_ORIGIN || `http://127.0.0.1:${port + 1}`;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: host === "0.0.0.0" ? "127.0.0.1" : host,
    port,
    strictPort: true,
    proxy: {
      "/api": {
        target,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
