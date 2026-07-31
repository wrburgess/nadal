import type Database from "better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

/**
 * The common shape every ingest write function accepts: either the top-level `db` from `openDb()`
 * or the `tx` handed to a `db.transaction(...)` callback. `BaseSQLiteDatabase` is the shared
 * ancestor of both `BetterSQLite3Database` and `SQLiteTransaction` — typing against it (rather
 * than the concrete `BetterSQLite3Database`) is what lets every upsert/identity function run
 * equally well inside or outside a transaction, which Task 6 requires (one transaction per pull).
 */
export type Db = BaseSQLiteDatabase<"sync", Database.RunResult, Record<string, never>>;
