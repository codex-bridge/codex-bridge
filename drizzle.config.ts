import { defineConfig } from "drizzle-kit";

const dbFile = process.env.BRIDGE_DB_FILE ?? "./workspaces/bridge.sqlite";

export default defineConfig({
  schema: "./src/store/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: dbFile
  }
});
