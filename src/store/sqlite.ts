/**
 * SQLite adapter — for tests, for local CLI use, and for the desktop client.
 *
 * This is the file that makes the port worth having. The same repository code,
 * the same statements in sql.ts, and the same MCP tool handlers run:
 *
 *   - on a Cloudflare Worker against D1,
 *   - in `bun test` against an in-memory database (no wrangler, no network),
 *   - inside a Tauri app against a file on the user's own disk.
 *
 * Only this file changes between them.
 *
 * Imported lazily via a dynamic `bun:sqlite` import so a Workers bundle that
 * never calls sqliteStore() does not try to resolve a Node/Bun builtin.
 */

import type { RunResult, Store } from "./types";

export interface SqliteLike {
  query(sql: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): { changes?: number; lastInsertRowid?: number | bigint };
  };
  exec?(sql: string): void;
  transaction?<T>(fn: () => T): () => T;
}

/**
 * Wrap an already-open bun:sqlite (or API-compatible) database.
 * Kept separate from `openSqliteStore` so a caller that manages its own handle
 * — a Tauri app holding one connection for the process lifetime — can use it.
 */
export function sqliteStore(database: SqliteLike): Store {
  const rows = <T>(sql: string, args: unknown[]): T[] =>
    database.query(sql).all(...args) as T[];

  return {
    driver: "sqlite",

    async all<T>(sql: string, args: unknown[] = []): Promise<T[]> {
      return rows<T>(sql, args);
    },

    async first<T>(sql: string, args: unknown[] = []): Promise<T | null> {
      return (database.query(sql).get(...args) as T | undefined) ?? null;
    },

    async run(sql: string, args: unknown[] = []): Promise<RunResult> {
      const result = database.query(sql).run(...args);
      return {
        changes: result?.changes ?? 0,
        lastRowId:
          typeof result?.lastInsertRowid === "bigint"
            ? Number(result.lastInsertRowid)
            : result?.lastInsertRowid,
      };
    },

    async batch(statements): Promise<RunResult[]> {
      if (statements.length === 0) return [];
      const apply = () =>
        statements.map((s) => {
          const result = database.query(s.sql).run(...(s.args ?? []));
          return { changes: result?.changes ?? 0 };
        });
      // A real transaction where the driver offers one; a plain loop otherwise.
      return database.transaction ? database.transaction(apply)() : apply();
    },
  };
}

/**
 * Open a SQLite file (or `:memory:`) and apply the migrations in order.
 *
 * Migrations are read as text and passed in by the caller rather than read from
 * disk here, so this works identically in a test, a CLI, and a bundled app that
 * has no filesystem layout to assume.
 */
export async function openSqliteStore(
  path: string,
  migrations: string[] = [],
): Promise<Store> {
  const { Database } = (await import("bun:sqlite")) as {
    Database: new (path: string) => SqliteLike & { exec(sql: string): void };
  };
  const database = new Database(path);
  // Foreign keys are OFF by default in SQLite — the ON DELETE CASCADE rules in
  // the schema are inert without this, and node_terms rows would outlive their
  // nodes. D1 enables them for you; a local file does not.
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) database.exec(migration);
  return sqliteStore(database);
}
