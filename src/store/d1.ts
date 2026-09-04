/**
 * D1 adapter — the Cloudflare Worker backend.
 *
 * D1's own API is already prepare/bind/all|first|run, so this file is thin by
 * design: it exists to keep that shape from leaking into the repository layer,
 * not because D1 needs wrapping.
 */

import type { RunResult, Store } from "./types";

export function d1Store(database: D1Database): Store {
  return {
    driver: "d1",

    async all<T>(sql: string, args: unknown[] = []): Promise<T[]> {
      const { results } = await database
        .prepare(sql)
        .bind(...args)
        .all<T>();
      return results ?? [];
    },

    async first<T>(sql: string, args: unknown[] = []): Promise<T | null> {
      return await database
        .prepare(sql)
        .bind(...args)
        .first<T>();
    },

    async run(sql: string, args: unknown[] = []): Promise<RunResult> {
      const result = await database
        .prepare(sql)
        .bind(...args)
        .run();
      return {
        changes: result.meta?.changes ?? 0,
        lastRowId: result.meta?.last_row_id,
      };
    },

    async batch(statements): Promise<RunResult[]> {
      if (statements.length === 0) return [];
      const results = await database.batch(
        statements.map((s) => database.prepare(s.sql).bind(...(s.args ?? []))),
      );
      return results.map((r) => ({
        changes: r.meta?.changes ?? 0,
        lastRowId: r.meta?.last_row_id,
      }));
    },
  };
}
