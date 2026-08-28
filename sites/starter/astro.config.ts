import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// PUBLIC_SITE_URL is the canonical origin of the deployed site (see .env.example).
export default defineConfig({
  site: process.env.PUBLIC_SITE_URL ?? "http://localhost:4321",
  vite: {
    plugins: [tailwindcss()],
  },
});
