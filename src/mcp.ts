/**
 * The MCP surface, hand-rolled against the JSON-RPC wire.
 *
 * Not the SDK, and that is a decision with a reason. This server is ONE
 * stateless POST endpoint. The SDK's transport layer exists to manage sessions
 * we do not want, and pinning it means inheriting its version churn on a Worker
 * that would otherwise have zero runtime dependencies.
 *
 * ── protocolVersion, the trap this fleet fell into three times ───────────────
 *
 * A client sends the revision it speaks. Three servers in this fleet answered
 * with THEIR revision, and clients that spoke a newer one connected, listed
 * zero tools, and reported no error on either side — a silent, symptomless
 * failure that took four wrong fixes to find once. So: we echo back the
 * client's requested version when we recognise its era, and fall back to our
 * newest known revision otherwise. Never hard-code one and reject the rest.
 */

import type { Store } from "./store/types";
import * as db from "./db";
import type { Embedder } from "./embed";
import { parseTermRef } from "./utils";

const SERVER_NAME = "digger-node";
const SERVER_VERSION = "0.1.0";

/** Revisions we know how to speak. A client asking for anything else still gets
 *  an answer — in the newest of these — rather than silence. */
const KNOWN_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

const text = (value: unknown) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

// ── tool catalogue ───────────────────────────────────────────────────────────
//
// Drupal in four nouns: node, vocabulary, term, and the join between them.
// Plus the log, because a tool surface you cannot inspect is one you cannot
// debug.

const TOOLS = [
  {
    name: "node_create",
    description:
      "Create a node: a title, a body, a datetime, a type. The unit of content — a post, a note, a bug, a page.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Required. 1-200 chars." },
        body: { type: "string", description: "Markdown or plain text. Optional." },
        type: { type: "string", description: "Content type, free text. Defaults to 'note'." },
        author: { type: "string" },
        status: { type: "integer", description: "1 published (default), 0 draft." },
        created_at: { type: "string", description: "ISO-8601. Defaults to now. Set it to import real history." },
        terms: {
          type: "array",
          items: { type: "string" },
          description: "Term names to tag with, as 'vocabulary:term' (e.g. 'tags:thailand'). Created if absent.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "node_get",
    description: "Read one node by id, with its taxonomy terms.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "node_update",
    description: "Change a node's title, body, type, status or author. Only the fields you pass move.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        type: { type: "string" },
        status: { type: "integer" },
        author: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "node_delete",
    description: "Delete a node permanently, with its tag links. Prefer status=0 (unpublish) — that is reversible.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "node_list",
    description:
      "List nodes newest first. Filter by type, status, vocabulary, or TAGS — pass `terms` as 'vocabulary:term' names (or `term_ids`), and set match='all' to require every tag (AND) or match='any' for at least one (OR, the default).",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        status: { type: "integer" },
        terms: {
          type: "array",
          items: { type: "string" },
          description: "Tag names, e.g. ['topics:mcp','tags:bangkok']. A bare name means the 'tags' vocabulary.",
        },
        term_ids: { type: "array", items: { type: "string" }, description: "Same, by id." },
        match: {
          type: "string",
          enum: ["any", "all"],
          description: "'any' (default) = at least one tag. 'all' = every tag must be present.",
        },
        term_id: { type: "string", description: "Single tag, shorthand." },
        untagged: {
          type: "boolean",
          description: "Only nodes with no tags at all — the queue of content still waiting to be classified.",
        },
        vocabulary: { type: "string", description: "Machine name — nodes tagged from that vocabulary." },
        limit: { type: "integer", description: "1-100, default 20." },
        offset: { type: "integer" },
      },
    },
  },
  {
    name: "node_types",
    description:
      "The content types in use, with counts. Types are DERIVED — a type exists because a node names it, there is no registry to maintain. To lock the set down, create a CONTROLLED vocabulary named 'type' and add terms to it; node_create then refuses anything not on that list.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "node_search",
    description:
      "Search title and body. mode='text' (DEFAULT) is a trigram index — it matches inside Thai words and is the right choice for finding something you half-remember. mode='semantic' embeds the query and ranks by meaning — use it when your words are a DESCRIPTION of the thing rather than a quote from it. mode='hybrid' merges both and is opt-in for a reason: measured on this fleet's own corpus it scored WORSE than pure text for known-item retrieval (0.44 vs 0.77 MRR), because equal-weight fusion lets a confident-but-wrong neighbour list drag down a confident-and-right lexical one. Every response reports the mode that actually ran and, for semantic, how much of the corpus is embedded.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        mode: { type: "string", enum: ["text", "semantic", "hybrid"], description: "Default 'text'." },
        limit: { type: "integer" },
      },
      required: ["query"],
    },
  },
  {
    name: "node_embed",
    description:
      "Embed nodes that have no vector yet, so semantic search can see them. Embedding is a second phase on purpose — writing content never waits for a model. Returns how many were embedded and the current coverage.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", description: "How many to embed this call. 1-200, default 25." } },
    },
  },
  {
    name: "node_tag",
    description:
      "Tag a node with terms, as 'vocabulary:term' (a bare name goes to 'tags'). In a free-tagging vocabulary missing terms are created; in a CONTROLLED one an unknown term is refused and the error lists what is available.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        terms: { type: "array", items: { type: "string" } },
      },
      required: ["id", "terms"],
    },
  },
  {
    name: "node_untag",
    description: "Remove terms from a node by term id. The terms themselves survive.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, term_ids: { type: "array", items: { type: "string" } } },
      required: ["id", "term_ids"],
    },
  },
  {
    name: "vocabulary_create",
    description:
      "Create a vocabulary — a namespace for terms. kind='tags' (default) is FREE-TAGGING: unknown terms are created on demand, good for many specific labels. kind='categories' is CONTROLLED: tagging with an unknown term fails, so use it for the few broad buckets you want to stay stable and un-drifted. Idempotent by name; an existing vocabulary is never re-kinded.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        label: { type: "string" },
        description: { type: "string" },
        kind: { type: "string", enum: ["tags", "categories"], description: "Default 'tags'." },
      },
      required: ["name"],
    },
  },
  {
    name: "vocabulary_list",
    description: "Every vocabulary.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "term_create",
    description:
      "Create a term in a vocabulary — the deliberate way to add to a CONTROLLED vocabulary. Hierarchical via parent_id. weight sets the order within its vocabulary (lower first), which is how a controlled vocabulary doubles as a menu. Idempotent by (vocabulary, name).",
    inputSchema: {
      type: "object",
      properties: {
        vocabulary: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        parent_id: { type: "string", description: "Nest under another term." },
        weight: { type: "integer", description: "Sort order within the vocabulary. Lower first. Default 0." },
        vocabulary_kind: {
          type: "string",
          enum: ["tags", "categories"],
          description: "Only used if this call also creates the vocabulary.",
        },
      },
      required: ["vocabulary", "name"],
    },
  },
  {
    name: "term_weight",
    description: "Set a term's sort order within its vocabulary. Lower sorts first — this is what turns a controlled vocabulary into an ordered menu.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, weight: { type: "integer" } },
      required: ["id", "weight"],
    },
  },
  {
    name: "term_list",
    description: "Terms, optionally within one vocabulary.",
    inputSchema: { type: "object", properties: { vocabulary: { type: "string" } } },
  },
  {
    name: "call_log",
    description:
      "Recent MCP tool calls with their arguments, outcome, result and duration — this server's own audit trail.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Filter to one tool name." },
        outcome: { type: "string", description: "'ok' or 'error'." },
        limit: { type: "integer", description: "1-200, default 20." },
      },
    },
  },
  {
    name: "call_stats",
    description: "Per-tool call counts, error counts, average duration and last-called time.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "status",
    description: "Corpus counts, content types, vocabularies, and this server's version.",
    inputSchema: { type: "object", properties: {} },
  },
];

/**
 * Fail with the caller's mistake, not the database's.
 *
 * Tagging a node that does not exist otherwise trips the node_terms foreign key
 * and the model is handed `D1_ERROR: FOREIGN KEY constraint failed:
 * SQLITE_CONSTRAINT`, which describes the storage engine's difficulty rather
 * than the thing the caller got wrong, and which no model can act on. Every
 * other tool in this file answers a bad id with `no node with id …`.
 */
async function requireNode(store: Store, id: string): Promise<db.NodeRow> {
  const node = await db.getNode(store, id);
  if (!node) throw new Error(`no node with id ${id}`);
  return node;
}

/** 'vocabulary:term' → term row, creating both if needed. A bare 'term' with no
 *  colon lands in the default 'tags' vocabulary, which is what a human means. */
export async function resolveTermRefs(store: Store, names: string[]): Promise<db.TermRow[]> {
  const out: db.TermRow[] = [];
  for (const raw of names) {
    const ref = parseTermRef(raw);
    if (!ref) continue;
    // Free-tagging creates; a controlled vocabulary refuses and lists what it
    // does have. That refusal is the whole point of the kind column.
    out.push(await db.resolveTermForTagging(store, ref.vocabulary, ref.name));
  }
  return out;
}

async function runTool(
  store: Store,
  name: string,
  args: Record<string, any>,
  instanceName: string,
  embedder: Embedder | null,
): Promise<unknown> {
  switch (name) {
    case "node_create": {
      const node = await db.createNode(store, args as any, embedder);
      if (Array.isArray(args.terms) && args.terms.length) {
        const terms = await resolveTermRefs(store, args.terms);
        await db.tagNode(store, node.id, terms.map((t) => t.id));
      }
      return { ...node, terms: await db.termsForNode(store, node.id) };
    }
    case "node_get": {
      const node = await db.getNode(store, String(args.id));
      if (!node) throw new Error(`no node with id ${args.id}`);
      return { ...node, terms: await db.termsForNode(store, node.id) };
    }
    case "node_update": {
      const node = await db.updateNode(store, String(args.id), args);
      if (!node) throw new Error(`no node with id ${args.id}`);
      return { ...node, terms: await db.termsForNode(store, node.id) };
    }
    case "node_delete": {
      const gone = await db.deleteNode(store, String(args.id));
      if (!gone) throw new Error(`no node with id ${args.id}`);
      return { deleted: args.id };
    }
    case "node_list": {
      const nodes = await db.listNodes(store, args);
      const tagged = args.terms?.length || args.term_ids?.length || args.term_id;
      return {
        // The match semantics are echoed back: "all" silently behaving as "any"
        // is the kind of filter bug you only notice as a wrong answer.
        ...(tagged ? { match: args.match === "all" ? "all" : "any" } : {}),
        count: nodes.length,
        nodes,
      };
    }
    case "node_types": {
      const types = await db.listTypes(store);
      const policy = await db.typePolicy(store);
      return { policy, count: types.length, types };
    }
    case "node_search": {
      const query = String(args.query ?? "");
      const want = String(args.mode ?? "text");

      // Semantic and hybrid both need an embedder. Saying so beats returning an
      // empty list that reads like "no matches".
      if ((want === "semantic" || want === "hybrid") && !embedder) {
        throw new Error(
          "semantic search needs an embedder; none is configured (bind Workers AI as `AI`). mode='text' still works.",
        );
      }

      if (want === "semantic" && embedder) {
        const { hits, coverage } = await db.semanticSearch(store, embedder, query, args.limit);
        return {
          query,
          mode: "semantic",
          space: embedder.space,
          // Coverage travels with the answer: a low score because a row was
          // never embedded is NOT a ranking result, and this fleet has already
          // misread that once.
          coverage: `${coverage.embedded}/${coverage.nodes} nodes embedded`,
          count: hits.length,
          nodes: hits,
        };
      }

      if (want === "hybrid" && embedder) {
        const text = await db.searchNodes(store, query, args);
        const semantic = await db.semanticSearch(store, embedder, query, args.limit);
        // Reciprocal rank fusion, k=60. Reported as its own mode, never as
        // "search" — the caller opted into a known trade.
        const K = 60;
        const scores = new Map<string, { node: db.NodeRow; rrf: number; inText: boolean; inVector: boolean }>();
        text.results.forEach((node, index) => {
          scores.set(node.id, { node, rrf: 1 / (K + index + 1), inText: true, inVector: false });
        });
        semantic.hits.forEach((hit, index) => {
          const existing = scores.get(hit.id);
          if (existing) {
            existing.rrf += 1 / (K + index + 1);
            existing.inVector = true;
          } else {
            scores.set(hit.id, { node: hit, rrf: 1 / (K + index + 1), inText: false, inVector: true });
          }
        });
        const merged = [...scores.values()].sort((a, b) => b.rrf - a.rrf).slice(0, args.limit ?? 20);
        return {
          query,
          mode: "hybrid",
          note: "RRF k=60. Measured worse than mode='text' for known-item recall on this fleet's corpus.",
          coverage: `${semantic.coverage.embedded}/${semantic.coverage.nodes} nodes embedded`,
          count: merged.length,
          // Per-hit provenance: which index actually found this row.
          nodes: merged.map((m) => ({ ...m.node, found_by: [m.inText && "text", m.inVector && "vector"].filter(Boolean) })),
        };
      }

      const { results, mode } = await db.searchNodes(store, query, args);
      // The mode is part of the answer, not a footnote: 'like' means recall is
      // a substring scan, not an index hit.
      return { query, mode, count: results.length, nodes: results };
    }
    case "node_embed": {
      if (!embedder) throw new Error("no embedder configured (bind Workers AI as `AI`)");
      const result = await db.embedMissing(store, embedder, Number(args.limit) || 25);
      const coverage = await db.embeddingCoverage(store, embedder);
      return { ...result, coverage };
    }
    case "node_tag": {
      // Check the node exists BEFORE resolving terms. Without this the insert
      // fails on the foreign key and the model is told
      // "D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT" — which
      // names the database's problem instead of the caller's, and is not
      // something a model can act on. Every other tool here says which id was
      // wrong; this one leaked the driver. Found by reading the call log.
      await requireNode(store, String(args.id));
      const terms = await resolveTermRefs(store, args.terms ?? []);
      const added = await db.tagNode(store, String(args.id), terms.map((t) => t.id));
      return { id: args.id, added, terms: await db.termsForNode(store, String(args.id)) };
    }
    case "node_untag": {
      await requireNode(store, String(args.id));
      const removed = await db.untagNode(store, String(args.id), args.term_ids ?? []);
      return { id: args.id, removed, terms: await db.termsForNode(store, String(args.id)) };
    }
    case "vocabulary_create":
      return await db.createVocabulary(store, args as any);
    case "vocabulary_list":
      return { vocabularies: await db.listVocabularies(store) };
    case "term_create":
      return await db.createTerm(store, {
        ...(args as any),
        vocabularyKind: args.vocabulary_kind,
      });
    case "term_weight": {
      const term = await db.setTermWeight(store, String(args.id), Number(args.weight));
      if (!term) throw new Error(`no term with id ${args.id}`);
      return term;
    }
    case "term_list":
      return { terms: await db.listTerms(store, args.vocabulary) };
    case "call_log":
      return { calls: await db.listCalls(store, args) };
    case "call_stats":
      return { tools: await db.callStats(store) };
    case "status":
      return {
        server: SERVER_NAME,
        version: SERVER_VERSION,
        instance: instanceName,
        tools: TOOLS.length,
        ...(await db.stats(store)),
        // Coverage in status, because an agent cannot otherwise ask how much of
        // the corpus semantic search can actually see.
        embedding: await db.embeddingCoverage(store, embedder),
      };
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/**
 * Takes an ALREADY-PARSED body, not a Request.
 *
 * The framework in front of this reads the body first; a second `request.json()`
 * here sees a consumed stream and every call fails as a parse error. Measured
 * 2026-09-03 — the symptom is every tool returning -32700 while /health is fine.
 */
export async function handleMcp(
  body: unknown,
  store: Store,
  instanceName = "digger-node",
  userAgent = "",
  embedder: Embedder | null = null,
): Promise<Response> {
  const rpc = (body ?? {}) as JsonRpcRequest;
  if (!rpc || typeof rpc !== "object" || typeof rpc.method !== "string") {
    return Response.json(err(null, -32700, "parse error"), { status: 400 });
  }

  const id = rpc.id ?? null;
  const method = rpc.method;
  const params = rpc.params ?? {};
  const client =
    (params.clientInfo as { name?: string } | undefined)?.name || userAgent || "unknown";

  switch (method) {
    case "initialize": {
      const asked = String((params as any).protocolVersion ?? "");
      const version = KNOWN_PROTOCOL_VERSIONS.includes(asked) ? asked : KNOWN_PROTOCOL_VERSIONS[0];
      return Response.json(
        ok(id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      );
    }
    // Notifications carry no id and expect no body.
    case "notifications/initialized":
    case "initialized":
      return new Response(null, { status: 202 });
    case "ping":
      return Response.json(ok(id, {}));
    case "tools/list":
      return Response.json(ok(id, { tools: TOOLS }));
    case "tools/call": {
      const name = String((params as any).name ?? "");
      const args = ((params as any).arguments ?? {}) as Record<string, unknown>;
      const started = Date.now();
      try {
        const result = await runTool(store, name, args as Record<string, any>, instanceName, embedder);
        await db.logCall(store, {
          tool: name,
          input: args,
          outcome: "ok",
          result,
          duration_ms: Date.now() - started,
          client,
        });
        return Response.json(ok(id, text(result)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await db.logCall(store, {
          tool: name,
          input: args,
          outcome: "error",
          result: message,
          duration_ms: Date.now() - started,
          client,
        });
        // isError keeps the failure inside the tool result, which is where an
        // MCP client shows it to the model — a JSON-RPC error would be a
        // transport fault instead, and the model would never see the reason.
        return Response.json(ok(id, { ...text(message), isError: true }));
      }
    }
    default:
      return Response.json(err(id, -32601, `method not found: ${method}`));
  }
}

export { TOOLS };
