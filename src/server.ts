/**
 * The self-hosted entry point: the same app, on your own disk.
 *
 * `index.ts` is the Cloudflare Worker and the only file that knows about D1.
 * This is its sibling for everywhere else — a Home Assistant add-on, a VM, a
 * laptop — and the only file that knows about a SQLite file. Between them sits
 * `createApp`, which has never been told which one it is running on.
 *
 * That is the whole argument for the `Store` port, cashed in: no route, no MCP
 * tool and no SQL statement changes to move this corpus off Cloudflare. The
 * difference between "hosted for you" and "yours on a box in your house" is
 * this file, and it is under a hundred lines.
 *
 *   DB_PATH        where the corpus lives           (default ./digger.db)
 *   PORT           what to listen on                (default 8099)
 *   HOST           bind address                     (default 0.0.0.0)
 *   INSTANCE_NAME  shown in the page header
 *   OWNER_PASSPHRASE / API_TOKEN   same meaning as on the Worker
 *   PUBLIC_URL     only behind a proxy that rewrites Host — see oauth.ts
 *   RATE_LIMIT     off/false/0 to disable throttling
 *
 * Deliberately absent: an embedder. Workers AI is a Cloudflare binding and has
 * no local equivalent here, so a self-hosted node runs TEXT SEARCH ONLY and
 * `/health` says so rather than implying a vector index that does not exist.
 * Wiring a local embedder later is one argument to createApp.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createApp } from "./app";
import { openSqliteStore } from "./store/sqlite";

/**
 * Every migration, in filename order, read at startup.
 *
 * Sorted lexically because the names are zero-padded (`0001_`, `0002_`…) and
 * that is the order they must run in. Read from disk rather than imported so
 * adding a migration is dropping in a file — the Worker path applies these
 * through `wrangler d1 migrations apply`, and this is the same list.
 *
 * Applying them on every boot is safe: each file is written to be idempotent
 * (`CREATE TABLE IF NOT EXISTS`, and `0004`'s rename guarded by a check), which
 * is what makes "start the container again" a working recovery step rather than
 * a data-loss event.
 */
function migrations(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(join(dir, name), "utf8"));
}

const dbPath = process.env.DB_PATH ?? "./digger.db";
const migrationsDir = process.env.MIGRATIONS_DIR ?? join(import.meta.dir, "..", "migrations");

const files = migrations(migrationsDir);
const store = await openSqliteStore(dbPath, files);

const app = createApp({
  store,
  instanceName: process.env.INSTANCE_NAME || "digger-node",
  // No Workers AI off-Cloudflare. `null` is honest; /health reports
  // "embedding: none" and search falls back to FTS, which is the behaviour the
  // Worker already has whenever the AI binding is absent.
  embedder: null,
  auth: {
    ownerPassphrase: process.env.OWNER_PASSPHRASE,
    apiToken: process.env.API_TOKEN,
  },
  publicUrl: process.env.PUBLIC_URL,
  rateLimit:
    process.env.RATE_LIMIT === undefined
      ? undefined
      : !["off", "false", "0", "no"].includes(process.env.RATE_LIMIT.trim().toLowerCase()),
});

const port = Number(process.env.PORT ?? 8099);
const hostname = process.env.HOST ?? "0.0.0.0";

Bun.serve({ port, hostname, fetch: app.fetch });

// One line, and it reports STATE rather than echoing config: the driver and the
// migration count are what actually happened at startup. A log that repeats the
// options it was handed stays reassuring through a total failure.
console.log(
  `digger-node listening on http://${hostname}:${port}  ` +
    `driver=${store.driver} db=${dbPath} migrations=${files.length} ` +
    `auth=${process.env.OWNER_PASSPHRASE || process.env.API_TOKEN ? "on" : "OPEN"}`,
);
