import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_DB_PATH = "data/nadal.db";

export function dbPath(): string {
  return process.env.TN_DB_PATH ?? DEFAULT_DB_PATH;
}

export function openDb(path: string = dbPath()) {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return { sqlite, db: drizzle(sqlite) };
}

export function runMigrations(path: string = dbPath()): void {
  const { db, sqlite } = openDb(path);
  migrate(db, { migrationsFolder: "drizzle" });
  sqlite.close();
}
