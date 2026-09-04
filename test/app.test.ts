/**
 * The whole stack against in-memory SQLite.
 *
 * This file is the proof that the Store port is real: the app, the repository,
 * the SQL and the MCP handlers under test here are byte-identical to the ones
 * the Worker runs. Only the adapter differs. If these pass and production
 * breaks, the difference is D1, not the code — which is a much shorter list of
 * things to check.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createApp } from "../src/app";
import { openSqliteStore } from "../src/store/sqlite";
import type { Store } from "../src/store/types";

const migrations = ["0001_init.sql", "0002_embeddings.sql", "0003_oauth.sql", "0004_oauth_hashed.sql"].map((file) =>
  readFileSync(join(import.meta.dir, "..", "migrations", file), "utf8"),
);

let store: Store;
let app: ReturnType<typeof createApp>;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await app.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const payload = (await response.json()) as any;
  const text = payload?.result?.content?.[0]?.text ?? "";
  return {
    isError: Boolean(payload?.result?.isError),
    text,
    data: (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })(),
  };
};

beforeEach(async () => {
  store = await openSqliteStore(":memory:", migrations);
  app = createApp({ store, instanceName: "test" });
});

describe("health", () => {
  test("reports which driver actually answered", async () => {
    const body = (await (await app.fetch(new Request("http://localhost/health"))).json()) as any;
    expect(body.ok).toBe(true);
    // The whole point of the store port: you never have to guess the backend.
    expect(body.driver).toBe("sqlite");
    expect(body.auth).toBe("none");
    expect(body.tools).toBeGreaterThanOrEqual(15);
  });
});

describe("mcp protocol", () => {
  test("echoes back the client's protocol version when known", async () => {
    const response = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", clientInfo: { name: "test-client" } },
        }),
      }),
    );
    const body = (await response.json()) as any;
    // The trap this fleet hit three times: answering with OUR version instead
    // of the client's makes a newer client connect and see zero tools.
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  test("answers an unknown protocol version rather than failing", async () => {
    const response = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2099-01-01" },
        }),
      }),
    );
    const body = (await response.json()) as any;
    expect(body.result.protocolVersion).toBe("2026-07-28");
    expect(body.result.serverInfo.name).toBe("digger-node");
  });

  test("lists every tool with a schema", async () => {
    const response = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      }),
    );
    const body = (await response.json()) as any;
    expect(body.result.tools.length).toBeGreaterThanOrEqual(15);
    for (const tool of body.result.tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  test("GET /mcp is a 405, not a 404 — the URL is right, the verb is not", async () => {
    const response = await app.fetch(new Request("http://localhost/mcp"));
    expect(response.status).toBe(405);
  });
});

describe("nodes", () => {
  test("create returns the row it wrote, with a real datetime", async () => {
    const { data } = await call("node_create", { title: "First", body: "hello", type: "article" });
    expect(data.title).toBe("First");
    expect(data.type).toBe("article");
    expect(data.status).toBe(1);
    expect(Number.isFinite(Date.parse(data.created_at))).toBe(true);
  });

  test("created_at can be set, so an importer keeps real history", async () => {
    const { data } = await call("node_create", { title: "Old", created_at: "2020-01-01T00:00:00.000Z" });
    expect(data.created_at).toBe("2020-01-01T00:00:00.000Z");
  });

  test("update moves only the fields passed", async () => {
    const created = (await call("node_create", { title: "Before", body: "keep me" })).data;
    const updated = (await call("node_update", { id: created.id, title: "After" })).data;
    expect(updated.title).toBe("After");
    expect(updated.body).toBe("keep me");
  });

  test("delete reports a miss instead of pretending", async () => {
    const result = await call("node_delete", { id: "node_nope" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("no node with id");
  });

  test("list is newest first and honours the limit", async () => {
    for (const title of ["a", "b", "c"]) await call("node_create", { title });
    const { data } = await call("node_list", { limit: 2 });
    expect(data.nodes.length).toBe(2);
    expect(data.nodes[0].title).toBe("c");
  });
});

describe("taxonomy", () => {
  test("node_create tags with 'vocabulary:term', creating both", async () => {
    const { data } = await call("node_create", {
      title: "Tagged",
      terms: ["tags:thailand", "status:draft", "bare"],
    });
    const names = data.terms.map((t: any) => `${t.vocabulary}:${t.name}`);
    expect(names).toContain("tags:thailand");
    expect(names).toContain("status:draft");
    // A bare name lands in the default vocabulary, which is what a human means.
    expect(names).toContain("tags:bare");
  });

  /**
   * Found by reading the call log in a screenshot: this used to surface
   * "D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT", which names
   * the storage engine's problem rather than the caller's and is not something
   * a model can act on.
   */
  test("tagging a node that does not exist names the id, not the constraint", async () => {
    const result = await call("node_tag", { id: "node_nope", terms: ["tags:x"] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("no node with id node_nope");
    expect(result.text).not.toContain("FOREIGN KEY");
  });

  test("untagging a node that does not exist says so too", async () => {
    const result = await call("node_untag", { id: "node_nope", term_ids: ["term_x"] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("no node with id node_nope");
  });

  test("tagging twice does not duplicate", async () => {
    const node = (await call("node_create", { title: "Once" })).data;
    await call("node_tag", { id: node.id, terms: ["tags:x"] });
    const second = await call("node_tag", { id: node.id, terms: ["tags:x"] });
    expect(second.data.added).toBe(0);
    expect(second.data.terms.length).toBe(1);
  });

  test("nodes can be listed by vocabulary", async () => {
    await call("node_create", { title: "In topics", terms: ["topics:mcp"] });
    await call("node_create", { title: "Untagged" });
    const { data } = await call("node_list", { vocabulary: "topics" });
    expect(data.nodes.length).toBe(1);
    expect(data.nodes[0].title).toBe("In topics");
  });

  test("untag removes the link but keeps the term", async () => {
    const node = (await call("node_create", { title: "T", terms: ["tags:keep"] })).data;
    const termId = node.terms[0].id;
    const after = await call("node_untag", { id: node.id, term_ids: [termId] });
    expect(after.data.terms.length).toBe(0);
    const terms = await call("term_list", { vocabulary: "tags" });
    expect(terms.data.terms.length).toBe(1);
  });
});

describe("vocabulary kinds — Drupal's tags vs categories", () => {
  test("a free-tagging vocabulary invents terms on demand", async () => {
    const { data } = await call("node_create", { title: "Free", terms: ["tags:whatever"] });
    expect(data.terms[0].name).toBe("whatever");
  });

  test("a CONTROLLED vocabulary refuses an unknown term, and says what it has", async () => {
    await call("vocabulary_create", { name: "section", kind: "categories" });
    await call("term_create", { vocabulary: "section", name: "engineering" });

    const refused = await call("node_create", { title: "Nope", terms: ["section:enginering"] });
    // The guard against a model inventing three spellings of one idea.
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("controlled vocabulary");
    expect(refused.text).toContain("engineering"); // tells it the real option

    const accepted = await call("node_create", { title: "Yes", terms: ["section:engineering"] });
    expect(accepted.isError).toBe(false);
  });

  test("an existing vocabulary is never silently re-kinded", async () => {
    await call("vocabulary_create", { name: "locked", kind: "categories" });
    // A second create with the permissive default must not disarm the guard.
    await call("vocabulary_create", { name: "locked", kind: "tags" });
    const refused = await call("node_tag", {
      id: (await call("node_create", { title: "x" })).data.id,
      terms: ["locked:invented"],
    });
    expect(refused.isError).toBe(true);
  });

  test("weight orders a vocabulary — which is what makes it a menu", async () => {
    await call("term_create", { vocabulary: "nav", name: "third", weight: 30 });
    await call("term_create", { vocabulary: "nav", name: "first", weight: 10 });
    await call("term_create", { vocabulary: "nav", name: "second", weight: 20 });
    const { data } = await call("term_list", { vocabulary: "nav" });
    expect(data.terms.map((t: any) => t.name)).toEqual(["first", "second", "third"]);
  });

  test("term_weight reorders after the fact", async () => {
    const a = (await call("term_create", { vocabulary: "nav2", name: "a", weight: 1 })).data;
    await call("term_create", { vocabulary: "nav2", name: "b", weight: 2 });
    await call("term_weight", { id: a.id, weight: 99 });
    const { data } = await call("term_list", { vocabulary: "nav2" });
    expect(data.terms.map((t: any) => t.name)).toEqual(["b", "a"]);
  });
});

describe("search", () => {
  test("finds a word inside a Thai sentence — the whole reason for trigram", async () => {
    await call("node_create", { title: "บันทึกไทย", body: "ระบบความจำสำหรับผู้ช่วยเอไอ" });
    const { data } = await call("node_search", { query: "ความจำ" });
    // unicode61 tokenizes that sentence as ONE token and returns 0 rows.
    expect(data.count).toBe(1);
    expect(data.mode).toBe("fts");
  });

  test("declares when it fell back to a LIKE scan", async () => {
    await call("node_create", { title: "ab short" });
    const { data } = await call("node_search", { query: "ab" });
    // Under 3 chars a trigram index has nothing to match — and the answer says so.
    expect(data.mode).toBe("like");
  });

  test("a needle with a quote is not a syntax error", async () => {
    await call("node_create", { title: 'He said "hello" loudly' });
    const { data } = await call("node_search", { query: '"hello"' });
    expect(data.count).toBeGreaterThanOrEqual(0); // must not throw
  });
});

describe("call log", () => {
  test("records every call with its input, result and duration", async () => {
    await call("node_create", { title: "Logged" });
    const { data } = await call("call_log", { limit: 10 });
    const entry = data.calls.find((c: any) => c.tool === "node_create");
    expect(entry).toBeTruthy();
    expect(entry.outcome).toBe("ok");
    expect(entry.input).toContain("Logged");
    expect(entry.result).toContain("Logged");
    expect(entry.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("records failures too — the calls you most want to read later", async () => {
    await call("node_get", { id: "node_missing" });
    const { data } = await call("call_log", { outcome: "error" });
    expect(data.calls.length).toBe(1);
    expect(data.calls[0].tool).toBe("node_get");
    expect(data.calls[0].result).toContain("no node with id");
  });

  test("call_stats counts calls and errors per tool", async () => {
    await call("node_create", { title: "one" });
    await call("node_get", { id: "nope" });
    const { data } = await call("call_stats");
    const byTool = Object.fromEntries(data.tools.map((t: any) => [t.tool, t]));
    expect(byTool.node_create.calls).toBe(1);
    expect(byTool.node_get.errors).toBe(1);
  });
});

describe("no auth", () => {
  test("an unauthenticated MCP call succeeds — that is the current posture", async () => {
    // Deliberate stage, not an oversight: a static bearer buys nothing for
    // claude.ai (which cannot send one), so the middle step was skipped in
    // favour of going straight to OAuth. See DESIGN.md.
    const response = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(response.status).toBe(200);
  });

  test("writes are open too, and /health says so rather than implying a guard", async () => {
    const write = await app.fetch(
      new Request("http://localhost/api/nodes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "anyone can write this" }),
      }),
    );
    expect(write.status).toBe(201);

    const health = (await (await app.fetch(new Request("http://localhost/health"))).json()) as any;
    expect(health.auth).toBe("none");
  });
});

describe("json api", () => {
  test("the web form's create path tags exactly like the MCP tool does", async () => {
    // Two write paths that disagree about tagging is the "a capability only
    // exists where its users are" bug this fleet keeps re-finding. Same
    // "vocabulary:term" syntax, same resulting rows.
    const response = await app.fetch(
      new Request("http://localhost/api/nodes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "From the form", terms: ["topics:web", "bare"] }),
      }),
    );
    expect(response.status).toBe(201);
    const node = (await response.json()) as any;
    const names = node.terms.map((t: any) => `${t.vocabulary}:${t.name}`);
    expect(names).toContain("topics:web");
    expect(names).toContain("tags:bare");

    // And a model listing by that vocabulary sees the form's node.
    const listed = await call("node_list", { vocabulary: "topics" });
    expect(listed.data.nodes.some((n: any) => n.title === "From the form")).toBe(true);
  });

  test("DELETE removes a node and 404s the second time", async () => {
    const node = (await call("node_create", { title: "Doomed" })).data;
    const first = await app.fetch(new Request(`http://localhost/api/nodes/${node.id}`, { method: "DELETE" }));
    expect(first.status).toBe(200);
    const second = await app.fetch(new Request(`http://localhost/api/nodes/${node.id}`, { method: "DELETE" }));
    expect(second.status).toBe(404);
  });

  test("serves the same nodes the MCP tools wrote", async () => {
    await call("node_create", { title: "Shared" });
    const body = (await (await app.fetch(new Request("http://localhost/api/nodes"))).json()) as any;
    expect(body.nodes[0].title).toBe("Shared");
  });

  test("stats report the corpus shape", async () => {
    await call("node_create", { title: "a", type: "article", terms: ["tags:x"] });
    const body = (await (await app.fetch(new Request("http://localhost/api/stats"))).json()) as any;
    expect(body.nodes).toBe(1);
    expect(body.by_type[0].type).toBe("article");
    expect(body.vocabularies[0].name).toBe("tags");
  });
});

describe("the page's generated JavaScript", () => {
  test("parses — the whole client is built inside a template literal", async () => {
    // This test exists because it already failed in production once. `\n`
    // written inside the TS template literal became a REAL newline in the
    // emitted HTML, so a JS string literal was cut in half and the browser
    // reported only `Uncaught SyntaxError: Invalid or unexpected token`.
    // Every route still returned 200; the page was simply inert. Nothing in
    // typecheck or any other test could see it, because the client code is a
    // string until a browser reads it.
    const { page } = await import("../src/page");
    const html = page("test-instance");
    const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();

    // new Function() parses without executing — a syntax error throws here.
    expect(() => new Function(script!)).not.toThrow();
  });

  test("uses the NL constant rather than an escape that must survive templating", async () => {
    // The convention that prevents the bug above: no escape sequence is written
    // into the client, because this whole file is a template literal and a
    // backslash-n here becomes a REAL newline there.
    //
    // (An earlier version of this test counted quotes per line and required an
    // even number. It flagged perfectly valid lines mixing ' and " — a
    // heuristic that fails on correct code is worse than no heuristic, and the
    // new Function() parse above is the real guard.)
    const { page } = await import("../src/page");
    const script = page("x").match(/<script type="module">([\s\S]*?)<\/script>/)![1];
    expect(script).toContain("const NL = String.fromCharCode(10)");
  });
});

/**
 * Semantic search, against a DETERMINISTIC fake embedder.
 *
 * A real model would make these tests slow, networked and non-reproducible, and
 * would test Cloudflare rather than this code. The fake maps text to a vector by
 * counting a few marker words, so "which row ranks first" has a right answer
 * that can be asserted — which is the only thing these tests are about.
 */
function fakeEmbedder(opts: { failing?: boolean } = {}) {
  const MARKERS = ["flood", "sensor", "taxonomy", "thai", "ความจำ", "search"];
  return {
    space: "fake:test:6",
    dim: 6,
    calls: 0,
    async embed(texts: string[]) {
      this.calls++;
      if (opts.failing) throw new Error("embedder is down");
      return texts.map((text) => {
        const lower = text.toLowerCase();
        return MARKERS.map((m) => (lower.includes(m) ? 1 : 0));
      });
    },
  };
}

describe("semantic search", () => {
  test("ranks by meaning, and reports the space and coverage", async () => {
    const embedder = fakeEmbedder();
    const withAi = createApp({ store, embedder });
    const mcp = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await withAi.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        }),
      );
      const payload = (await r.json()) as any;
      return { isError: !!payload.result?.isError, text: payload.result.content[0].text };
    };

    await mcp("node_create", { title: "Flood sensor notes", body: "the flood sensor readings" });
    await mcp("node_create", { title: "Taxonomy design", body: "vocabulary and taxonomy shapes" });

    const result = JSON.parse((await mcp("node_search", { query: "taxonomy", mode: "semantic" })).text);
    expect(result.mode).toBe("semantic");
    expect(result.space).toBe("fake:test:6");
    expect(result.nodes[0].title).toBe("Taxonomy design");
    // Coverage travels with the answer — a low score because a row was never
    // embedded is not a ranking result.
    expect(result.coverage).toBe("2/2 nodes embedded");
  });

  test("a down embedder never costs the write", async () => {
    const embedder = fakeEmbedder({ failing: true });
    const withAi = createApp({ store, embedder });
    const response = await withAi.fetch(
      new Request("http://localhost/api/nodes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Written while the model was down" }),
      }),
    );
    // The content is durable; only the vector is missing, and that is backfillable.
    expect(response.status).toBe(201);
    const listed = (await (await withAi.fetch(new Request("http://localhost/api/nodes"))).json()) as any;
    expect(listed.nodes[0].title).toBe("Written while the model was down");
  });

  test("semantic without an embedder says so instead of returning nothing", async () => {
    // The failure mode this avoids: an empty list that reads as "no matches".
    const result = await call("node_search", { query: "anything", mode: "semantic" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("needs an embedder");
  });

  test("text mode is the default and needs no embedder at all", async () => {
    await call("node_create", { title: "plain text search still works" });
    const { data } = await call("node_search", { query: "still works" });
    expect(data.mode).toBe("fts");
  });

  test("node_embed backfills what create could not", async () => {
    // Nodes written with no embedder present.
    await call("node_create", { title: "first unembedded" });
    await call("node_create", { title: "second unembedded" });

    const embedder = fakeEmbedder();
    const withAi = createApp({ store, embedder });
    const run = await withAi.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: "node_embed", arguments: { limit: 10 } },
        }),
      }),
    );
    const result = JSON.parse(((await run.json()) as any).result.content[0].text);
    expect(result.embedded).toBe(2);
    expect(result.coverage.embedded).toBe(2);
  });

  test("hybrid reports per-hit provenance and warns it is the worse default", async () => {
    const embedder = fakeEmbedder();
    const withAi = createApp({ store, embedder });
    const mcp = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await withAi.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        }),
      );
      return JSON.parse(((await r.json()) as any).result.content[0].text);
    };
    await mcp("node_create", { title: "flood sensor log", body: "flood" });

    const result = await mcp("node_search", { query: "flood", mode: "hybrid" });
    expect(result.mode).toBe("hybrid");
    // The measured trade is stated in the response, not buried in a doc.
    expect(result.note).toContain("worse");
    // Which index actually found each row — never a merged score with no origin.
    expect(result.nodes[0].found_by.length).toBeGreaterThan(0);
  });

  test("status carries embedding coverage, which most fleet tools omit", async () => {
    const embedder = fakeEmbedder();
    const withAi = createApp({ store, embedder });
    const r = await withAi.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status", arguments: {} } }),
      }),
    );
    const status = JSON.parse(((await r.json()) as any).result.content[0].text);
    expect(status.embedding).toMatchObject({ space: "fake:test:6" });
    expect(typeof status.embedding.embedded).toBe("number");
  });

  test("vectors from another space are never compared", async () => {
    const a = fakeEmbedder();
    const appA = createApp({ store, embedder: a });
    await appA.fetch(new Request("http://localhost/api/nodes", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "embedded in space A, about taxonomy" }),
    }));

    // A different deployment — same shape, different space identity.
    const b = { ...fakeEmbedder(), space: "fake:other:6" };
    const appB = createApp({ store, embedder: b });
    const r = await appB.fetch(new Request("http://localhost/mcp", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "node_search", arguments: { query: "taxonomy", mode: "semantic" } },
      }),
    }));
    const result = JSON.parse(((await r.json()) as any).result.content[0].text);
    // Space B sees zero vectors, and its coverage says so — rather than
    // silently ranking against a foreign space.
    expect(result.count).toBe(0);
    expect(result.coverage).toContain("0/");
  });
});

describe("both write doors behave identically", () => {
  test("MCP and REST both embed — the bug this fleet has shipped four times", async () => {
    // arra-memory shipped "write embedded via REST but not MCP", twice in
    // different directions. The fix is not to remember both call sites; it is
    // to have one. createNode() takes the embedder, so neither door can drift.
    const embedder = fakeEmbedder();
    const app2 = createApp({ store, embedder });

    await app2.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: "node_create", arguments: { title: "via mcp, about taxonomy" } },
        }),
      }),
    );
    await app2.fetch(
      new Request("http://localhost/api/nodes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "via rest, about taxonomy" }),
      }),
    );

    const stats = (await (await app2.fetch(new Request("http://localhost/api/stats"))).json()) as any;
    // Two nodes in, two vectors out. Neither door is privileged.
    expect(stats.embedding.embedded).toBe(2);
    expect(stats.embedding.nodes).toBe(2);
  });
});

describe("vector round-trip across drivers", () => {
  test("unpacks D1's number[] blob, not just bun's Uint8Array", async () => {
    const { packVector, unpackVector, cosine } = await import("../src/embed");
    const original = [0.5, -0.25, 0.125, 1];
    const packed = packVector(original);

    // bun:sqlite gives back a Uint8Array.
    expect([...unpackVector(packed)]).toEqual(original);

    // D1 gives back a plain array of BYTE values. Treating that as an
    // ArrayBuffer copies each byte AS a float — 16 small integers instead of 4
    // floats — and nothing throws. It was live for one deploy: every cosine
    // came back ~0.00, which reads as "nothing is related".
    const asD1 = [...packed];
    expect([...unpackVector(asD1)]).toEqual(original);

    // The symptom, locked: identical vectors must score 1, not ~0.
    expect(cosine(unpackVector(asD1), original)).toBeCloseTo(1, 5);
  });
});

describe("multi-tag filtering", () => {
  beforeEach(async () => {
    await call("node_create", { title: "both", terms: ["topics:mcp", "tags:bangkok"] });
    await call("node_create", { title: "only mcp", terms: ["topics:mcp"] });
    await call("node_create", { title: "only bangkok", terms: ["tags:bangkok"] });
    await call("node_create", { title: "neither" });
  });

  test("match='any' is OR — at least one tag", async () => {
    const { data } = await call("node_list", { terms: ["topics:mcp", "tags:bangkok"], match: "any" });
    expect(data.match).toBe("any");
    expect(data.nodes.map((n: any) => n.title).sort()).toEqual(["both", "only bangkok", "only mcp"]);
  });

  test("match='all' is AND — every tag present", async () => {
    // The classic tag-filter bug is writing AND as a WHERE, which returns
    // nothing at all: no single join row can equal two different terms.
    const { data } = await call("node_list", { terms: ["topics:mcp", "tags:bangkok"], match: "all" });
    expect(data.match).toBe("all");
    expect(data.nodes.map((n: any) => n.title)).toEqual(["both"]);
  });

  test("'any' is the default, and the response echoes which ran", async () => {
    const { data } = await call("node_list", { terms: ["topics:mcp", "tags:bangkok"] });
    expect(data.match).toBe("any");
    expect(data.nodes.length).toBe(3);
  });

  test("a repeated tag does not change an 'all' match", async () => {
    // Deduped before counting: otherwise ['x','x'] would require two matches
    // of one term and silently return nothing.
    const { data } = await call("node_list", { terms: ["topics:mcp", "topics:mcp"], match: "all" });
    expect(data.nodes.map((n: any) => n.title).sort()).toEqual(["both", "only mcp"]);
  });

  test("term_ids works alongside names, and unknown names are simply absent", async () => {
    const terms = (await call("term_list", { vocabulary: "topics" })).data.terms;
    const byId = await call("node_list", { term_ids: [terms[0].id] });
    expect(byId.data.nodes.length).toBe(2);

    const unknown = await call("node_list", { terms: ["topics:does-not-exist"], match: "all" });
    expect(unknown.data.nodes.length).toBe(0);
  });

  test("tags combine with a type filter", async () => {
    await call("node_create", { title: "typed", type: "article", terms: ["topics:mcp"] });
    const { data } = await call("node_list", { terms: ["topics:mcp"], type: "article" });
    expect(data.nodes.map((n: any) => n.title)).toEqual(["typed"]);
  });
});

describe("content types", () => {
  test("types are derived — a type exists because a node names it", async () => {
    await call("node_create", { title: "a", type: "article" });
    await call("node_create", { title: "b", type: "article" });
    await call("node_create", { title: "c", type: "recipe" });
    const { data } = await call("node_types");
    expect(data.policy).toBe("free");
    expect(data.types.find((t: any) => t.type === "article").count).toBe(2);
    expect(data.types.map((t: any) => t.type)).toContain("recipe");
  });

  test("a controlled 'type' vocabulary locks the set — same guard as tags", async () => {
    await call("vocabulary_create", { name: "type", kind: "categories" });
    await call("term_create", { vocabulary: "type", name: "article" });

    const allowed = await call("node_create", { title: "fine", type: "article" });
    expect(allowed.isError).toBe(false);

    const refused = await call("node_create", { title: "nope", type: "aritcle" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("not an allowed content type");
    expect(refused.text).toContain("article");

    expect((await call("node_types")).data.policy).toBe("controlled");
  });

  test("the guard applies to updates too, not just creates", async () => {
    await call("vocabulary_create", { name: "type", kind: "categories" });
    await call("term_create", { vocabulary: "type", name: "article" });
    const node = (await call("node_create", { title: "x", type: "article" })).data;
    const refused = await call("node_update", { id: node.id, type: "smuggled" });
    expect(refused.isError).toBe(true);
  });
});

describe("the UI's write endpoints", () => {
  test("a vocabulary can be created from the browser, with its kind", async () => {
    const response = await app.fetch(
      new Request("http://localhost/api/vocabularies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "section", kind: "categories", label: "Sections" }),
      }),
    );
    expect(response.status).toBe(201);
    expect(((await response.json()) as any).kind).toBe("categories");
  });

  test("a term can be created with a weight — the menu order", async () => {
    for (const [name, weight] of [["second", 20], ["first", 10]] as const) {
      await app.fetch(new Request("http://localhost/api/terms", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ vocabulary: "nav", name, weight }),
      }));
    }
    const body = (await (await app.fetch(new Request("http://localhost/api/terms?vocabulary=nav"))).json()) as any;
    expect(body.terms.map((t: any) => t.name)).toEqual(["first", "second"]);
  });

  test("terms carry usage counts — without them a cloud is just a list", async () => {
    await call("node_create", { title: "a", terms: ["tags:popular"] });
    await call("node_create", { title: "b", terms: ["tags:popular"] });
    await call("node_create", { title: "c", terms: ["tags:rare"] });
    // A term nobody uses must still appear, at 0 — hiding it would make a fresh
    // controlled vocabulary look broken.
    await call("term_create", { vocabulary: "tags", name: "unused" });

    const body = (await (await app.fetch(new Request("http://localhost/api/terms?vocabulary=tags"))).json()) as any;
    const usage = Object.fromEntries(body.terms.map((t: any) => [t.name, t.usage]));
    expect(usage.popular).toBe(2);
    expect(usage.rare).toBe(1);
    expect(usage.unused).toBe(0);
  });

  test("an existing node can be tagged from the UI", async () => {
    const node = (await call("node_create", { title: "untagged" })).data;
    const response = await app.fetch(
      new Request(`http://localhost/api/nodes/${node.id}/tags`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ terms: ["topics:added-later"] }),
      }),
    );
    const body = (await response.json()) as any;
    expect(body.added).toBe(1);
    expect(body.terms[0].name).toBe("added-later");
  });

  test("a refusal comes back as JSON so the form can show it verbatim", async () => {
    await call("vocabulary_create", { name: "type", kind: "categories" });
    await call("term_create", { vocabulary: "type", name: "article" });
    const response = await app.fetch(
      new Request("http://localhost/api/nodes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x", type: "aritcle" }),
      }),
    );
    expect(response.ok).toBe(false);
    // Elysia's default error body is plain text, which would turn the single
    // most useful string in the system into "HTTP 500" in the browser.
    const body = (await response.json()) as any;
    expect(body.message).toContain("not an allowed content type");
    expect(body.message).toContain("article");
  });
});

describe("tagging is the model's job", () => {
  test("the untagged queue is what a human hands to an agent", async () => {
    await call("node_create", { title: "classified", terms: ["topics:done"] });
    await call("node_create", { title: "waiting a" });
    await call("node_create", { title: "waiting b" });

    const body = (await (await app.fetch(new Request("http://localhost/api/nodes?untagged=1"))).json()) as any;
    expect(body.nodes.map((n: any) => n.title).sort()).toEqual(["waiting a", "waiting b"]);
  });

  test("and it empties as the model tags — the queue is a real signal", async () => {
    const node = (await call("node_create", { title: "untouched" })).data;
    let queue = (await (await app.fetch(new Request("http://localhost/api/nodes?untagged=1"))).json()) as any;
    expect(queue.count).toBe(1);

    // What an agent does over MCP.
    await call("node_tag", { id: node.id, terms: ["topics:classified-by-agent"] });

    queue = (await (await app.fetch(new Request("http://localhost/api/nodes?untagged=1"))).json()) as any;
    expect(queue.count).toBe(0);
  });

  test("untagged is reachable over MCP too, so an agent can find its own work", async () => {
    await call("node_create", { title: "for the agent" });
    const { data } = await call("node_list", { untagged: true });
    expect(data.nodes.map((n: any) => n.title)).toContain("for the agent");
  });

  test("the create form does not ask a human for tags", async () => {
    const { page } = await import("../src/page");
    const html = page("x");
    // No tag input, no picker: a person supplies title/body/type — the things a
    // person knows — and classification is left to something that is good at it.
    expect(html).not.toContain('id="f_terms"');
    expect(html).not.toContain('id="tagPicker"');
    // Tags still appear, as READ controls.
    expect(html).toContain("filter by this tag");
  });
});
