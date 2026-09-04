/**
 * The Cloudflare Worker entry point.
 *
 * This file is the ONLY place that knows the backend is D1. It builds a store
 * from the binding, hands it to the Elysia app, and gets out of the way — which
 * is what lets the identical app run in `bun test` against in-memory SQLite and,
 * later, inside a desktop build against a file on disk.
 *
 * The app is built per request rather than once at module scope because a
 * Worker's bindings arrive with the request, not with the isolate. Elysia's
 * construction is cheap; correctness here is worth more than the microseconds.
 */

import { createApp } from "./app";
import { workersAiEmbedder } from "./embed";
import { d1Store } from "./store/d1";

export interface Env {
  DB: D1Database;
  /** Optional. Absent = text search only; /health reports which. */
  AI?: Ai;
  EMBED_MODEL?: string;
  INSTANCE_NAME?: string;

  /**
   * Both optional, both secrets, and the server is OPEN with neither set.
   *
   *   wrangler secret put OWNER_PASSPHRASE   enables OAuth (claude.ai) + login
   *   wrangler secret put API_TOKEN          enables a static bearer (curl, MCP
   *                                          clients that read a config file)
   *
   * Secrets rather than vars deliberately: a `vars` entry lives in
   * wrangler.jsonc, and wrangler.jsonc is committed.
   */
  OWNER_PASSPHRASE?: string;
  API_TOKEN?: string;

  /**
   * Only needed behind a proxy that rewrites Host. The OAuth `issuer` must
   * equal the origin the client actually reached, byte for byte — see oauth.ts
   * on why a mismatch here fails silently and only for OAuth clients.
   */
  PUBLIC_URL?: string;

  /**
   * Set to "off"/"false"/"0" to disable throttling of the passphrase endpoints.
   * On by default whenever auth is on — the deployment that most needs a
   * guessing budget is the one nobody configured. Reasonable to disable behind
   * Cloudflare Access, on a private network, or with a long passphrase.
   */
  RATE_LIMIT?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const app = createApp({
      store: d1Store(env.DB),
      instanceName: env.INSTANCE_NAME || "digger-node",
      // Multilingual by default. Measured on this fleet: MiniLM-class models are
      // blind to Thai, which is half this corpus.
      embedder: env.AI ? workersAiEmbedder(env.AI, env.EMBED_MODEL || "@cf/baai/bge-m3") : null,
      auth: { ownerPassphrase: env.OWNER_PASSPHRASE, apiToken: env.API_TOKEN },
      publicUrl: env.PUBLIC_URL,
      // undefined when the var is absent, so createApp's own default applies.
      // Coercing an unset var to `true` here would force throttling on even
      // with auth off, which is a different decision than "leave it to default".
      rateLimit:
        env.RATE_LIMIT === undefined
          ? undefined
          : !["off", "false", "0", "no"].includes(env.RATE_LIMIT.trim().toLowerCase()),
    });
    return app.fetch(request);
  },
};
