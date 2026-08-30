import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/persistence/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.FACTORY_DATABASE_URL ||
      process.env.FACTORY_TEST_DATABASE_URL ||
      "postgresql://factory:password@localhost:5432/factory",
  },
});
