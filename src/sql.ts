/**
 * Every SQL statement in this Worker, in one file, as named constants.
 *
 * Nothing else in the codebase writes SQL. That is the whole point: the
 * complete surface that touches the database can be read top to bottom in one
 * sitting, which is what makes it auditable — and it means swapping D1 for any
 * other SQLite is a change of transport, not of behaviour.
 *
 * Every statement is parameterised with `?`. The only interpolation permitted
 * anywhere in this file is the composable fragments at the bottom, which build
 * WHERE/JOIN clauses out of THIS FILE'S OWN string literals and never out of
 * caller input — caller values always arrive as bind arguments.
 *
 * The schema itself is not here: it lives in migrations/, because D1 applies
 * migrations and tracks which ones ran. Duplicating CREATE TABLE here would
 * create two truths about the same tables.
 */

export const NODES = {
  insert: `INSERT INTO nodes (id, type, title, body, created_at, updated_at, status, author)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,

  byId: `SELECT * FROM nodes WHERE id = ?`,

  /** Every column is written; the caller merges with the existing row first, so
   *  "only the fields you pass move" is enforced above, not in SQL. */
  update: `UPDATE nodes SET type = ?, title = ?, body = ?, status = ?, author = ?, updated_at = ?
           WHERE id = ?`,

  delete: `DELETE FROM nodes WHERE id = ?`,

  count: `SELECT COUNT(*) AS c FROM nodes`,

  /** Trigram FTS. bm25() ascends — lower is better — so no ORDER BY DESC here. */
  searchFts: `SELECT n.* FROM nodes_fts f
              JOIN nodes n ON n.rowid = f.rowid
              WHERE nodes_fts MATCH ?
              ORDER BY bm25(nodes_fts)
              LIMIT ?`,

  /** The fallback when the needle is under 3 chars, or FTS5 is unavailable. */
  searchLike: `SELECT * FROM nodes
               WHERE title LIKE ? OR body LIKE ?
               ORDER BY created_at DESC, rowid DESC
               LIMIT ?`,
} as const;

export const VOCABULARIES = {
  insert: `INSERT INTO vocabularies (id, name, label, description, kind, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
  byId: `SELECT * FROM vocabularies WHERE id = ?`,
  byName: `SELECT * FROM vocabularies WHERE name = ?`,
  list: `SELECT * FROM vocabularies ORDER BY name`,

  /**
   * What a delete would destroy, so it can be reported BEFORE it happens.
   *
   * `terms.vocabulary_id` and `node_terms.term_id` both cascade (0001_init.sql),
   * so removing a vocabulary silently takes every term in it and every tag
   * assignment those terms carried. That is a lot of work to lose to a typo.
   * args: vocabularyId
   */
  impact: `SELECT
             (SELECT COUNT(*) FROM terms WHERE vocabulary_id = ?1) AS terms,
             (SELECT COUNT(*) FROM node_terms nt
                JOIN terms t ON t.id = nt.term_id
               WHERE t.vocabulary_id = ?1) AS assignments`,

  // args: vocabularyId
  delete: `DELETE FROM vocabularies WHERE id = ?`,
} as const;

export const TERMS = {
  insert: `INSERT INTO terms (id, vocabulary_id, name, description, parent_id, weight, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
  byId: `SELECT * FROM terms WHERE id = ?`,
  byVocabAndName: `SELECT * FROM terms WHERE vocabulary_id = ? AND name = ?`,

  // weight first, name second — the owner's chosen order, then a stable
  // tiebreaker. This is what lets a controlled vocabulary render as a menu.
  //
  // `usage` is the count of nodes wearing the term. LEFT JOIN, not JOIN: a term
  // with no nodes must still appear (as 0), or a freshly created vocabulary
  // looks broken. It is what makes a tag CLOUD possible — a cloud whose sizes
  // do not encode usage is just a list with inconsistent typography.
  list: `SELECT t.*, v.name AS vocabulary, v.kind AS vocabulary_kind,
                COUNT(nt.node_id) AS usage
         FROM terms t
         JOIN vocabularies v ON v.id = t.vocabulary_id
         LEFT JOIN node_terms nt ON nt.term_id = t.id
         GROUP BY t.id
         ORDER BY v.name, t.weight, t.name`,

  listInVocabulary: `SELECT t.*, v.name AS vocabulary, v.kind AS vocabulary_kind,
                            COUNT(nt.node_id) AS usage
                     FROM terms t
                     JOIN vocabularies v ON v.id = t.vocabulary_id
                     LEFT JOIN node_terms nt ON nt.term_id = t.id
                     WHERE v.name = ?
                     GROUP BY t.id
                     ORDER BY t.weight, t.name`,

  setWeight: `UPDATE terms SET weight = ? WHERE id = ?`,
} as const;

export const NODE_TERMS = {
  /** OR IGNORE makes tagging idempotent — tagging twice is not an error. */
  tag: `INSERT OR IGNORE INTO node_terms (node_id, term_id) VALUES (?, ?)`,
  untag: `DELETE FROM node_terms WHERE node_id = ? AND term_id = ?`,
  forNode: `SELECT t.*, v.name AS vocabulary FROM node_terms nt
            JOIN terms t ON t.id = nt.term_id
            JOIN vocabularies v ON v.id = t.vocabulary_id
            WHERE nt.node_id = ?
            ORDER BY v.name, t.name`,
} as const;

export const VECTORS = {
  /** Replace: re-embedding a node overwrites its vector in the same space. */
  upsert: `INSERT INTO node_vectors (node_id, model, dim, vector, text_hash, embedded_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(node_id) DO UPDATE SET
             model = excluded.model, dim = excluded.dim, vector = excluded.vector,
             text_hash = excluded.text_hash, embedded_at = excluded.embedded_at`,

  /** Every vector IN ONE SPACE, with its node. Filtering on (model, dim) is not
   *  optional — a vector from another space is not comparable, and comparing it
   *  anyway returns confident nonsense with no error. */
  allInSpace: `SELECT n.*, v.vector, v.text_hash FROM node_vectors v
               JOIN nodes n ON n.id = v.node_id
               WHERE v.model = ? AND v.dim = ?`,

  /** Nodes with no vector in this space, oldest first — the backfill queue. */
  missing: `SELECT n.* FROM nodes n
            LEFT JOIN node_vectors v ON v.node_id = n.id AND v.model = ?
            WHERE v.node_id IS NULL
            ORDER BY n.created_at ASC
            LIMIT ?`,

  /** Coverage, which most tools in this fleet forget to report — and a Thai
   *  query once scored zero purely because its rows were not embedded yet. */
  coverage: `SELECT
               (SELECT COUNT(*) FROM nodes) AS nodes,
               (SELECT COUNT(*) FROM node_vectors WHERE model = ?) AS embedded,
               (SELECT COUNT(DISTINCT model) FROM node_vectors) AS spaces`,

  /** Vectors whose node text has changed since embedding — stale, not wrong. */
  stale: `SELECT n.id, n.title FROM node_vectors v JOIN nodes n ON n.id = v.node_id
          WHERE v.model = ? AND v.text_hash <> ?`,

  deleteForNode: `DELETE FROM node_vectors WHERE node_id = ?`,
} as const;

export const CALLS = {
  insert: `INSERT INTO mcp_calls (id, called_at, tool, input, outcome, result, duration_ms, client)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,

  stats: `SELECT tool,
                 COUNT(*) AS calls,
                 SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors,
                 CAST(AVG(duration_ms) AS INTEGER) AS avg_ms,
                 MAX(called_at) AS last_called
          FROM mcp_calls
          GROUP BY tool
          ORDER BY calls DESC`,
} as const;

export const TYPES = {
  /**
   * Content types are DERIVED, not a table — `SELECT DISTINCT type` is the whole
   * registry. Same reasoning as workspace/project elsewhere in this fleet: a
   * type exists the moment a node names it and stops existing when the last one
   * goes, with nothing to keep in step. The drift risk that creates is handled
   * by the optional controlled vocabulary, not by a second table.
   */
  list: `SELECT type, COUNT(*) AS count, MAX(created_at) AS newest
         FROM nodes GROUP BY type ORDER BY count DESC, type`,
} as const;

export const STATS = {
  nodes: `SELECT COUNT(*) AS total,
                 SUM(status) AS published,
                 MIN(created_at) AS oldest,
                 MAX(created_at) AS newest
          FROM nodes`,

  byType: `SELECT type, COUNT(*) AS count FROM nodes GROUP BY type ORDER BY count DESC`,

  vocabularies: `SELECT v.name, COUNT(t.id) AS terms
                 FROM vocabularies v
                 LEFT JOIN terms t ON t.vocabulary_id = v.id
                 GROUP BY v.id
                 ORDER BY v.name`,
} as const;

/**
 * OAuth 2.1. Three tables, no ORM, no KV namespace.
 *
 * `expires_at` is epoch SECONDS everywhere in this block, while the rest of the
 * schema uses ISO strings. That is deliberate and not drift: these columns are
 * only ever compared against a clock, never displayed or sorted next to a
 * node's `created_at`, and an integer comparison cannot be defeated by a
 * timezone suffix the way a string one can.
 */
export const OAUTH = {
  clients: {
    // args: clientId, clientName, redirectUrisJson, createdAt
    register: `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at)
               VALUES (?, ?, ?, ?)`,

    // args: clientId
    byId: `SELECT client_id, client_name, redirect_uris, created_at
             FROM oauth_clients WHERE client_id = ?`,

    /** Who has ever connected, with how many tokens are live right now.
     *  LEFT JOIN so "registered once, nothing active" still shows — that is
     *  information, not an empty row.  args: nowSeconds */
    list: `SELECT c.client_id, c.client_name, c.created_at,
                  COUNT(t.token_hash) AS active_tokens,
                  MAX(t.created_at) AS last_token_at
             FROM oauth_clients c
             LEFT JOIN oauth_tokens t
               ON t.client_id = c.client_id
              AND (t.expires_at IS NULL OR t.expires_at > ?)
            GROUP BY c.client_id
            ORDER BY c.created_at DESC`,
  },

  codes: {
    // args: codeHash, clientId, redirectUri, challenge, method, scope, resource, expiresAt
    issue: `INSERT INTO oauth_codes
              (code_hash, client_id, redirect_uri, code_challenge,
               code_challenge_method, scope, resource, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,

    // args: codeHash, nowSeconds
    consume: `SELECT code_hash, client_id, redirect_uri, code_challenge,
                     code_challenge_method, scope, resource, expires_at
                FROM oauth_codes
               WHERE code_hash = ? AND expires_at > ?`,

    /** Single-use. The caller deletes on EVERY exchange attempt, successful or
     *  not — otherwise an intercepted code grants unlimited guesses at the
     *  verifier.  args: codeHash */
    delete: `DELETE FROM oauth_codes WHERE code_hash = ?`,

    // args: nowSeconds
    sweep: `DELETE FROM oauth_codes WHERE expires_at <= ?`,

    // args: clientId
    deleteForClient: `DELETE FROM oauth_codes WHERE client_id = ?`,
  },

  tokens: {
    // args: tokenHash, clientId, scope, resource, createdAt, expiresAt|null
    issue: `INSERT INTO oauth_tokens (token_hash, client_id, scope, resource, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)`,

    // args: tokenHash, nowSeconds
    verify: `SELECT token_hash, client_id, scope, resource, created_at, expires_at
               FROM oauth_tokens
              WHERE token_hash = ?
                AND (expires_at IS NULL OR expires_at > ?)`,

    // args: tokenHash
    revoke: `DELETE FROM oauth_tokens WHERE token_hash = ?`,

    // args: clientId
    revokeForClient: `DELETE FROM oauth_tokens WHERE client_id = ?`,

    // args: nowSeconds
    sweep: `DELETE FROM oauth_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?`,
  },
} as const;

/** Throttling for the two endpoints that take a human-chosen passphrase.
 *  `last_at` is epoch SECONDS, like the OAuth expiries — only ever compared to
 *  a clock. */
export const RATE = {
  // args: bucket, clientIp
  get: `SELECT failures, last_at FROM auth_attempts WHERE bucket = ? AND client_ip = ?`,

  /** One failure, resetting the count when the caller has been quiet for a
   *  whole window. Resetting HERE rather than sweeping on a schedule means a
   *  caller who returns an hour later starts clean with nothing having had to
   *  run in between.  args: bucket, clientIp, now, windowStart, now */
  fail: `INSERT INTO auth_attempts (bucket, client_ip, failures, last_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(bucket, client_ip) DO UPDATE SET
           failures = CASE WHEN auth_attempts.last_at < ? THEN 1 ELSE auth_attempts.failures + 1 END,
           last_at  = ?`,

  /** A correct passphrase clears the record — mistyping twice then succeeding
   *  must not carry those failures forward.  args: bucket, clientIp */
  clear: `DELETE FROM auth_attempts WHERE bucket = ? AND client_ip = ?`,
} as const;

/** Key/value settings. One row per decision, so adding a setting is an INSERT
 *  rather than a migration — the same reason taxonomy is rows. */
export const SETTINGS = {
  get: `SELECT value FROM settings WHERE key = ?`,
  // args: key, value, updatedAt
  put: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  delete: `DELETE FROM settings WHERE key = ?`,
} as const;

/**
 * The corpus as one chronology.
 *
 * Two kinds of event — a node was written, a tool was called — interleaved and
 * ordered by EVENT TIME, which is the whole point: neither table alone shows the
 * shape of a working session, and reading either one by insertion order is how
 * you get a timeline that quietly lies.
 *
 * `ORDER BY at DESC, rowid DESC` and not `ORDER BY at DESC` alone. This project
 * has already had a same-millisecond collision produce non-deterministic order
 * in a list, caught by a test rather than by reasoning. Wall-clock time is not a
 * unique key at machine speed, so the insertion counter is the tiebreaker.
 *
 * args: limit
 */
export const TIMELINE = {
  recent: `SELECT * FROM (
             SELECT 'node' AS kind, n.id AS id, n.created_at AS at,
                    n.title AS label, n.type AS detail, NULL AS outcome,
                    NULL AS duration_ms, n.rowid AS seq
               FROM nodes n
             UNION ALL
             SELECT 'call' AS kind, c.id AS id, c.called_at AS at,
                    c.tool AS label, c.client AS detail, c.outcome AS outcome,
                    c.duration_ms AS duration_ms, c.rowid AS seq
               FROM mcp_calls c
           )
           ORDER BY at DESC, seq DESC
           LIMIT ?`,
} as const;

// ── composable statements ────────────────────────────────────────────────────
//
// Two queries take a variable shape: listing nodes (filters + optional taxonomy
// join) and listing calls (filters). Both are built from the fragments below —
// literals defined HERE, never caller strings — with every caller value bound.

/** The taxonomy joins a node listing may need. Keys are chosen by the caller's
 *  filter shape, never by a caller-supplied string. */
const NODE_JOINS = {
  none: "",
  byTerm: `JOIN node_terms nt ON nt.node_id = n.id`,
  byVocabulary: `JOIN node_terms nt ON nt.node_id = n.id
                 JOIN terms t ON t.id = nt.term_id
                 JOIN vocabularies v ON v.id = t.vocabulary_id`,
} as const;

/**
 * `?, ?, ?` for N bound values.
 *
 * The only place this file builds SQL from a number rather than a literal. It
 * is safe for the reason all of this is safe: the COUNT comes from the caller,
 * the VALUES are still bound, and no caller string is ever concatenated.
 */
const placeholders = (count: number): string => new Array(count).fill("?").join(", ");

export type NodeJoin = keyof typeof NODE_JOINS;

/**
 * Nodes NOTHING has tagged yet.
 *
 * Tagging is the model's job, so "what has not been classified" is a real
 * working queue rather than a curiosity — it is the list a human hands to an
 * agent, and the list that shows whether the agent is keeping up.
 */
export function listUntaggedSql(where: string[]): string {
  const conditions = [...where, "nt.node_id IS NULL"];
  return `SELECT n.* FROM nodes n
          LEFT JOIN node_terms nt ON nt.node_id = n.id
          WHERE ${conditions.join(" AND ")}
          ORDER BY n.created_at DESC, n.rowid DESC
          LIMIT ? OFFSET ?`;
}

/** `where` entries must come from the caller's own literal set below. */
export const NODE_WHERE = {
  type: `n.type = ?`,
  status: `n.status = ?`,
  termId: `nt.term_id = ?`,
  vocabularyName: `v.name = ?`,
} as const;

/**
 * Nodes carrying ANY of these terms, or ALL of them.
 *
 * "any" is a plain IN with DISTINCT. "all" cannot be — a row is only in the
 * result if it matched every term, which is a GROUP BY / HAVING count, not a
 * WHERE. Getting this wrong is the classic tag-filter bug: an AND written as a
 * WHERE returns nothing at all, because no single join row can equal two terms.
 */
export function listNodesByTermsSql(termCount: number, match: "any" | "all", where: string[]): string {
  const conditions = [...where, `nt.term_id IN (${placeholders(termCount)})`];
  if (match === "any") {
    return `SELECT DISTINCT n.* FROM nodes n
            JOIN node_terms nt ON nt.node_id = n.id
            WHERE ${conditions.join(" AND ")}
            ORDER BY n.created_at DESC, n.rowid DESC
            LIMIT ? OFFSET ?`;
  }
  return `SELECT n.* FROM nodes n
          JOIN node_terms nt ON nt.node_id = n.id
          WHERE ${conditions.join(" AND ")}
          GROUP BY n.id
          HAVING COUNT(DISTINCT nt.term_id) = ?
          ORDER BY n.created_at DESC, n.rowid DESC
          LIMIT ? OFFSET ?`;
}

/** Resolve "vocabulary:term" pairs to ids in one round trip. */
export function termIdsByNameSql(count: number): string {
  return `SELECT t.id, t.name, v.name AS vocabulary FROM terms t
          JOIN vocabularies v ON v.id = t.vocabulary_id
          WHERE (v.name || ':' || t.name) IN (${placeholders(count)})`;
}

export function listNodesSql(join: NodeJoin, where: string[]): string {
  // rowid DESC is the tiebreaker, and it is load-bearing: created_at has
  // millisecond resolution, so a bulk import (or a test) writing several rows
  // inside one millisecond leaves the order undefined without it. Insert order
  // is the only thing that can break that tie honestly.
  return `SELECT DISTINCT n.* FROM nodes n ${NODE_JOINS[join]}
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY n.created_at DESC, n.rowid DESC
          LIMIT ? OFFSET ?`;
}

export const CALL_WHERE = {
  tool: `tool = ?`,
  outcome: `outcome = ?`,
} as const;

export function listCallsSql(where: string[]): string {
  // Same tiebreaker, same reason — a burst of tool calls shares a millisecond
  // routinely, and a log that reorders itself between reads is not a log.
  return `SELECT * FROM mcp_calls
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY called_at DESC, rowid DESC
          LIMIT ?`;
}
