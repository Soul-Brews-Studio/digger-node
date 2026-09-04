/**
 * The HTTP surface, as an Elysia app.
 *
 * The app is built by a FUNCTION that takes a Store, not by a module that
 * reaches for a global. That is what keeps the same routes usable in three
 * places: a Worker hands it a D1-backed store, `bun test` hands it an in-memory
 * SQLite one, and a desktop build would hand it a file on disk. Nothing in this
 * file knows which it got.
 *
 * Elysia here is doing routing and validation, not architecture: every handler
 * is a few lines that calls the repository and returns plain JSON.
 */

import { Elysia, t } from "elysia";

import { authenticate, authEnabled, authModes, type AuthConfig } from "./auth";
import { authPlugin } from "./auth-plugin";
import * as db from "./db";
import { handleMcp, resolveTermRefs, TOOLS } from "./mcp";
import { page } from "./page";
import { readStored } from "./passphrase";
import { loginPage } from "./screens";
import type { Embedder } from "./embed";
import type { Store } from "./store/types";

export interface AppOptions {
  store: Store;
  instanceName?: string;
  version?: string;
  /** Optional by contract. Absent = text search only, and /health says so. */
  embedder?: Embedder | null;
  /** Optional by contract. Absent = open server, and /health says that too. */
  auth?: AuthConfig;
  /** Overrides the origin advertised in OAuth metadata. Only needed behind a
   *  proxy that rewrites Host — see oauth.ts on why this must be exact. */
  publicUrl?: string;
  /** Throttle the passphrase endpoints. Defaults ON whenever auth is on. */
  rateLimit?: boolean;
}

const SERVER_VERSION = "0.2.0";

/**
 * Authentication is OPT-IN, and which state a deployment is in is never left to
 * be inferred.
 *
 *   no secrets set        the server is open — anyone who can reach the URL can
 *                         read and write. /health says `"auth": "none"`, and the
 *                         page says so on its face.
 *   API_TOKEN set         a static bearer works. For curl, Claude Code, a Tauri
 *                         client — anything that can send a header.
 *   OWNER_PASSPHRASE set  OAuth 2.1 + PKCE + DCR is live, which is the only door
 *                         claude.ai can walk through, and the browser gets a
 *                         cookie session behind the same passphrase.
 *
 * Open-by-default is a deliberate choice for a one-click install, not laziness:
 * a deploy button that produces a Worker returning 401 to its own owner, with no
 * screen on which to set a secret, is a broken first run. The cost is real, so
 * it is stated in three places rather than hidden in one.
 */
export function createApp({
  store,
  instanceName = "digger-node",
  version = SERVER_VERSION,
  embedder = null,
  auth = {},
  publicUrl,
  rateLimit,
}: AppOptions) {
  const guarded = authEnabled(auth);
  const throttled = rateLimit ?? guarded;
  return (
    // aot: false is REQUIRED on Cloudflare Workers and is not a tuning knob.
    // Elysia's default ahead-of-time compiler builds handlers with `new
    // Function()`, and workerd refuses code generation from strings:
    //   EvalError: Code generation from strings disallowed for this context
    // The failure appears on the FIRST request of a deploy, not at build time
    // and not in `bun test` — which is exactly the shape of bug that reaches
    // production. Measured here 2026-09-03 against `wrangler dev`.
    new Elysia({ aot: false })
      // The page and a desktop client both call this cross-origin. Reads are
      // safe to share; writes still require the token.
      .onAfterHandle(({ set }) => {
        set.headers["access-control-allow-origin"] = "*";
        set.headers["access-control-allow-headers"] = "authorization, content-type, mcp-protocol-version";
        set.headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
      })
      .options("/*", () => new Response(null, { status: 204 }))

      /**
       * An empty body is an empty object, not a parse error.
       *
       * A DELETE sent with `content-type: application/json` and no body — which
       * curl does the moment you reuse a header array, and which several HTTP
       * clients do by default — otherwise fails with
       * `Unexpected end of JSON input`. That names the parser's problem rather
       * than the caller's, and points nowhere near the DELETE that caused it.
       * Measured here while testing the vocabulary escape hatch.
       */
      .onParse(async ({ request }, contentType) => {
        if (!contentType?.startsWith("application/json")) return;
        const text = await request.text();
        return text.trim() ? JSON.parse(text) : {};
      })

      /**
       * The gate, the OAuth endpoints and the browser login, in one `.use()`.
       *
       * Mounted BEFORE the corpus routes below, because its `onBeforeHandle` is
       * globally scoped and must be registered before the routes it guards.
       * Everything auth-shaped lives in auth-plugin.ts; nothing below this line
       * needs to know authentication exists.
       */
      .use(authPlugin({ store, auth, publicUrl, instanceName, rateLimit }))

      /**
       * Errors answer as JSON, always.
       *
       * A thrown refusal is not an internal fault here — it is the product
       * telling you why: "\"aritcle\" is not an allowed content type.
       * Available: article, note." The browser form renders `message` verbatim,
       * so returning Elysia's default plain-text body would turn the single
       * most useful string in the system into "HTTP 500".
       */
      .onError(({ code, error, set }) => {
        const message = error instanceof Error ? error.message : String(error);
        if (code === "VALIDATION") {
          set.status = 400;
          return { error: "validation", message };
        }
        if (code === "NOT_FOUND") {
          set.status = 404;
          return { error: "not_found", message };
        }
        set.status = 400;
        return { error: "request_failed", message };
      })

      // ── MCP ────────────────────────────────────────────────────────────────
      .post("/mcp", async ({ body, headers }) =>
        // Elysia has already parsed the body; handleMcp takes the object, not
        // the Request, because reading the stream twice yields nothing.
        handleMcp(body, store, instanceName, headers["user-agent"] ?? "", embedder),
      )
      /**
       * Streamable HTTP defines GET as "open an SSE stream" and DELETE as "end
       * this session". This server is stateless and has neither, so both answer
       * 405 — the status that means "this URL is right, that verb is not".
       *
       * A 404 would be actively misleading: a client probing transports reads
       * it as a wrong URL and gives up on the endpoint entirely, rather than
       * falling back to plain POST, which works.
       */
      .get("/mcp", ({ set }) => {
        set.status = 405;
        return { error: "method_not_allowed", hint: "POST JSON-RPC to /mcp" };
      })
      .delete("/mcp", ({ set }) => {
        set.status = 405;
        return { error: "method_not_allowed", hint: "stateless: there is no session to end" };
      })

      // ── health ─────────────────────────────────────────────────────────────
      .get("/health", async () => {
        let ok = true;
        let nodes = 0;
        try {
          nodes = await db.countNodes(store);
        } catch {
          ok = false;
        }
        return {
          ok,
          server: "digger-node",
          version,
          instance: instanceName,
          driver: store.driver,
          // Stated every time, so an operator never has to guess or assume —
          // and specific about WHICH doors are open, because "auth: true" on a
          // server where only the static token is configured would read as
          // "claude.ai can connect", which it could not.
          auth: guarded ? authModes(auth) : "none",
          // Stated, not inferred: whether the passphrase endpoints have a
          // guessing budget. No extra query — it is a resolved config value.
          rate_limit: guarded ? throttled : null,
          tools: TOOLS.length,
          nodes,
          // Named, not implied: a caller can see whether semantic search is
          // even possible before it returns an empty list.
          embedder: embedder ? embedder.space : null,
        };
      })

      // ── read API ───────────────────────────────────────────────────────────
      .get("/api/nodes", async ({ query }) => {
        if (query.q) {
          const { results, mode } = await db.searchNodes(store, String(query.q), {
            limit: query.limit ? Number(query.limit) : undefined,
          });
          return { mode, count: results.length, nodes: results };
        }
        // Comma-separated so a URL stays readable: ?terms=topics:mcp,tags:bangkok&match=all
        const split = (value?: string) =>
          value ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
        const nodes = await db.listNodes(store, {
          type: query.type,
          vocabulary: query.vocabulary,
          term_id: query.term_id,
          terms: split(query.terms),
          term_ids: split(query.term_ids),
          match: query.match === "all" ? "all" : "any",
          untagged: query.untagged === "1" || query.untagged === "true",
          status: query.status !== undefined ? Number(query.status) : undefined,
          limit: query.limit ? Number(query.limit) : undefined,
          offset: query.offset ? Number(query.offset) : undefined,
        });
        return { count: nodes.length, nodes };
      })

      .get("/api/nodes/:id", async ({ params, set }) => {
        const node = await db.getNode(store, params.id);
        if (!node) {
          set.status = 404;
          return { error: "not_found" };
        }
        return { ...node, terms: await db.termsForNode(store, params.id) };
      })

      .get("/api/vocabularies", async () => ({ vocabularies: await db.listVocabularies(store) }))

      /** What deleting this vocabulary would cost, before deciding to. */
      .get("/api/vocabularies/:name/impact", async ({ params, set }) => {
        const impact = await db.vocabularyImpact(store, params.name);
        if (!impact) {
          set.status = 404;
          return { error: "not_found", message: `no vocabulary named "${params.name}"` };
        }
        return impact;
      })

      /**
       * The escape hatch every "controlled vocabulary" error has been promising.
       *
       * `assertTypeAllowed` tells callers to "delete the controlled type
       * vocabulary to allow free text" — advice that named an operation this
       * codebase did not have, so the only real way out was raw SQL. Deleting is
       * refused unless `?force=1` when terms would go with it, because the
       * cascade is silent and "delete the vocabulary" reads far cheaper than
       * "delete every tag anyone applied from it".
       */
      .delete("/api/vocabularies/:name", async ({ params, query, set }) => {
        try {
          const gone = await db.deleteVocabulary(store, params.name, query.force === "1" || query.force === "true");
          return { deleted: params.name, ...gone };
        } catch (error) {
          set.status = error instanceof Error && error.message.startsWith("no vocabulary") ? 404 : 409;
          return { error: "refused", message: error instanceof Error ? error.message : "failed" };
        }
      })

      .get("/api/terms", async ({ query }) => ({
        terms: await db.listTerms(store, query.vocabulary),
      }))

      .get("/api/calls", async ({ query }) => ({
        calls: await db.listCalls(store, {
          tool: query.tool,
          outcome: query.outcome,
          limit: query.limit ? Number(query.limit) : undefined,
        }),
      }))

      .get("/api/calls/stats", async () => ({ tools: await db.callStats(store) }))

      // Taxonomy writes, so the UI can manage vocabularies and terms without
      // dropping to MCP. Same functions the tools call — one implementation.
      .post(
        "/api/vocabularies",
        async ({ body, set }) => {
          set.status = 201;
          return await db.createVocabulary(store, body);
        },
        {
          body: t.Object({
            name: t.String({ minLength: 1, maxLength: 64 }),
            label: t.Optional(t.String()),
            description: t.Optional(t.String()),
            kind: t.Optional(t.Union([t.Literal("tags"), t.Literal("categories")])),
          }),
        },
      )

      .post(
        "/api/terms",
        async ({ body, set }) => {
          set.status = 201;
          return await db.createTerm(store, {
            ...body,
            vocabularyKind: body.vocabulary_kind,
          });
        },
        {
          body: t.Object({
            vocabulary: t.String({ minLength: 1 }),
            name: t.String({ minLength: 1, maxLength: 128 }),
            description: t.Optional(t.String()),
            parent_id: t.Optional(t.String()),
            weight: t.Optional(t.Integer()),
            vocabulary_kind: t.Optional(t.Union([t.Literal("tags"), t.Literal("categories")])),
          }),
        },
      )

      /** Tag an existing node, by "vocabulary:term" names — the UI's tag picker. */
      .post(
        "/api/nodes/:id/tags",
        async ({ params, body, set }) => {
          const node = await db.getNode(store, params.id);
          if (!node) {
            set.status = 404;
            return { error: "not_found" };
          }
          const resolved = await resolveTermRefs(store, body.terms);
          const added = await db.tagNode(store, node.id, resolved.map((term) => term.id));
          return { id: node.id, added, terms: await db.termsForNode(store, node.id) };
        },
        { body: t.Object({ terms: t.Array(t.String()) }) },
      )

      .get("/api/types", async () => ({
        policy: await db.typePolicy(store),
        types: await db.listTypes(store),
      }))

      .get("/api/tools", () => ({ tools: TOOLS }))

      /** The corpus as one chronology — nodes and tool calls interleaved by
       *  event time, merged in SQL so the rowid tiebreaker is available. */
      .get("/api/timeline", async ({ query }) => ({
        events: await db.timeline(store, query.limit ? Number(query.limit) : undefined),
      }))

      .get("/api/stats", async () => ({
        ...(await db.stats(store)),
        embedding: await db.embeddingCoverage(store, embedder),
      }))

      // ── write API ──────────────────────────────────────────────────────────
      // Takes the same `terms: ["vocabulary:term"]` shape the MCP tool does, so
      // the web form and a model produce identical rows. Two write paths that
      // disagree about tagging is the "capability only exists where its users
      // are" bug this fleet keeps re-finding.
      .post(
        "/api/nodes",
        async ({ body, set }) => {
          const { terms, ...fields } = body;
          const node = await db.createNode(store, fields, embedder);
          if (terms?.length) {
            const resolved = await resolveTermRefs(store, terms);
            await db.tagNode(store, node.id, resolved.map((term) => term.id));
          }
          set.status = 201;
          return { ...node, terms: await db.termsForNode(store, node.id) };
        },
        {
          body: t.Object({
            title: t.String({ minLength: 1, maxLength: 200 }),
            body: t.Optional(t.String()),
            type: t.Optional(t.String()),
            author: t.Optional(t.String()),
            status: t.Optional(t.Integer({ minimum: 0, maximum: 1 })),
            created_at: t.Optional(t.String()),
            terms: t.Optional(t.Array(t.String())),
          }),
        },
      )

      .delete("/api/nodes/:id", async ({ params, set }) => {
        const gone = await db.deleteNode(store, params.id);
        if (!gone) {
          set.status = 404;
          return { error: "not_found" };
        }
        return { deleted: params.id };
      })

      // ── the page ───────────────────────────────────────────────────────────
      /**
       * The page decides for itself rather than being 401'd by the gate.
       *
       * A browser handed a bare 401 renders a blank tab: no form, no
       * explanation, nothing to click. So `/` is on the gate's allow-list and
       * answers with the lock screen instead — same check, a result a human can
       * act on. The 200 is deliberate; this is a page, not an API refusal, and
       * nothing about the corpus is in it.
       */
      .get("/", async ({ request }) => {
        const key = (auth.ownerPassphrase ?? "") + "\u0000" + ((await readStored(store)) ?? "");
        if (guarded && !(await authenticate(store, request, auth, undefined, key)).ok) {
          return new Response(loginPage({ instanceName }), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response(page(instanceName), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      })
  );
}

export type App = ReturnType<typeof createApp>;
