/**
 * The site: one HTML page, inlined. No build step, no bundle, no CDN.
 *
 * Organised the way the data is — content in the main column, taxonomy as the
 * navigation beside it — because that is the whole argument for the Drupal
 * shape. A flat list would render the same rows and teach you nothing about why
 * vocabularies exist.
 *
 * WHO TAGS: the model, not the person at the keyboard. The create form asks a
 * human for a title, a body and a type — the things a human actually knows —
 * and does not ask them to type "topics:mcp, tags:bangkok". Classification is
 * what an agent is good at and what MCP is for. So in this page every tag is a
 * READ control: click one to filter by it. The only tag-shaped thing a human
 * gets is the "untagged" queue, which shows what the model has not reached yet.
 *
 * Everything the UI writes goes through the SAME endpoints the MCP tools call.
 * There is no browser-only path: a node typed here and one written by a model
 * are indistinguishable rows, and neither door can quietly gain a capability
 * the other lacks. That is the defect class this codebase keeps catching.
 *
 * ── the escaping rule, learned the hard way ─────────────────────────────────
 *
 * This whole file is one template literal, so a backslash-n written here becomes
 * a REAL newline in the emitted HTML — which once cut a JS string literal in
 * half and produced `Uncaught SyntaxError` while every route still returned 200.
 * Use the NL constant and string concatenation. Never write an escape that has
 * to survive into the client.
 */

export function page(instance: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(instance)} · digger-node</title>
<style>
  :root {
    --bg:#0f1117; --panel:#161923; --line:#262b38; --ink:#e6e8ee; --dim:#9aa3b5;
    --accent:#7cc4ff; --ok:#6fd08c; --bad:#ff8a8a; --chip:#1e2431;
    color-scheme: dark;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#fbfbfd; --panel:#fff; --line:#e3e6ee; --ink:#1a1d26; --dim:#5d6577; --accent:#0a68c4; --chip:#eef1f7; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  header { padding:12px 20px; border-bottom:1px solid var(--line); display:flex;
           gap:12px; align-items:center; flex-wrap:wrap; position:sticky; top:0;
           background:var(--bg); z-index:5; }
  h1 { font-size:15px; margin:0; }
  h1 a { color:inherit; text-decoration:none; }
  .dim { color:var(--dim); }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  .num { font-variant-numeric:tabular-nums; }
  .grow { flex:1; }
  input, textarea, select, button {
    font:inherit; color:inherit; background:var(--panel);
    border:1px solid var(--line); border-radius:7px; padding:6px 9px;
  }
  input:focus, textarea:focus, select:focus { outline:2px solid var(--accent); outline-offset:-1px; }
  button { cursor:pointer; }
  button.primary { background:var(--accent); color:#0b1017; border-color:transparent; font-weight:600; }
  button.ghost { background:transparent; font-size:12px; padding:3px 8px; }
  .layout { display:grid; grid-template-columns:300px 1fr; gap:18px; padding:18px 20px;
            max-width:1240px; align-items:start; }
  @media (max-width:900px) { .layout { grid-template-columns:1fr; } }
  aside { display:grid; gap:14px; }
  section { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:13px 15px; }
  h2 { font-size:12px; margin:0 0 10px; text-transform:uppercase; letter-spacing:.09em;
       color:var(--dim); font-weight:600; display:flex; justify-content:space-between;
       align-items:center; gap:8px; }
  form { display:grid; gap:8px; }
  .row { display:flex; gap:8px; flex-wrap:wrap; }
  .row > * { flex:1; min-width:110px; }
  label.field { display:grid; gap:3px; font-size:11px; color:var(--dim); }
  .vocab { margin-bottom:12px; }
  .vocab > b { display:flex; gap:6px; align-items:baseline; font-size:12px;
               color:var(--dim); margin-bottom:5px; font-weight:600; }
  .kind { font-weight:400; font-size:10px; text-transform:uppercase; letter-spacing:.07em; opacity:.6; }
  .term { display:inline-block; margin:0 5px 5px 0; padding:2px 9px; border-radius:99px;
          background:var(--chip); border:1px solid transparent; cursor:pointer;
          font-size:12px; line-height:1.5; }
  .term:hover { border-color:var(--accent); }
  .term[aria-pressed="true"] { border-color:var(--accent); color:var(--accent); }
  .term .n { opacity:.5; font-size:.8em; margin-left:4px; font-variant-numeric:tabular-nums; }
  /* A cloud sizes by usage; a menu is ordered by weight and stays uniform. */
  .menu .term { display:block; margin:0 0 3px; border-radius:6px; font-size:12px; }
  .cloud { display:flex; flex-wrap:wrap; align-items:baseline; }
  .cloud .term.unused { opacity:.45; }
  article { border-bottom:1px solid var(--line); padding:13px 0; }
  article:first-of-type { padding-top:0; }
  article:last-child { border-bottom:0; padding-bottom:0; }
  article h3 { margin:0 0 4px; font-size:15px; font-weight:600; }
  article .meta { font-size:12px; color:var(--dim); display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  article p { margin:6px 0 0; white-space:pre-wrap; overflow-wrap:anywhere; }
  .pill { display:inline-block; padding:1px 7px; border:1px solid var(--line);
          border-radius:99px; font-size:11px; color:var(--dim); }
  .pill.tag { border-color:transparent; background:var(--chip); cursor:pointer; }
  .pill.tag:hover { color:var(--accent); }
  .empty { color:var(--dim); font-style:italic; padding:9px 0; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:600; }
  tr:last-child td { border-bottom:0; }
  .ok { color:var(--ok); } .bad { color:var(--bad); }
  .wrap { max-width:44ch; overflow-wrap:anywhere; }
  details.yaml { max-width:52ch; }
  details.yaml > summary { cursor:pointer; list-style:none; color:var(--dim);
                           font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  details.yaml > summary::-webkit-details-marker { display:none; }
  details.yaml > summary::before { content:"> "; }
  details.yaml[open] > summary::before { content:"v "; }
  details.yaml pre { margin:6px 0 0; padding:8px 10px; background:var(--chip);
                     border-radius:6px; font-size:11.5px; line-height:1.5;
                     overflow-x:auto; white-space:pre; }
  .k { color:var(--dim); }
  .stats { display:flex; gap:18px; flex-wrap:wrap; }
  .stat b { display:block; font-size:19px; font-weight:600; font-variant-numeric:tabular-nums; }
  .stat span { font-size:11px; color:var(--dim); }
  .msg { font-size:12px; min-height:16px; }
  .msg.bad { color:var(--bad); }
  .msg.ok { color:var(--ok); }
  a { color:var(--accent); }
</style>
</head>
<body>
<header>
  <h1><a href="#/">${escapeHtml(instance)}</a></h1>
  <span class="dim mono">digger-node</span>
  <form class="grow row" id="searchForm" style="max-width:440px" onsubmit="return false">
    <input id="q" type="search" placeholder="Search title and body..." autocomplete="off" style="flex:2">
    <select id="searchMode" style="flex:0 0 auto"
      title="text = trigram index. semantic = meaning. hybrid = both, and measured worse than text.">
      <option value="text">text</option>
      <option value="semantic">semantic</option>
      <option value="hybrid">hybrid</option>
    </select>
  </form>
  <span class="dim mono" id="health"></span>
</header>

<div class="layout">
  <aside>
    <section>
      <h2>Add content</h2>
      <form id="createForm">
        <input id="f_title" placeholder="Title" required maxlength="200">
        <textarea id="f_body" placeholder="Body" rows="4"></textarea>
        <label class="field">type
          <span class="row" style="gap:6px">
            <select id="f_type_select" style="flex:2"></select>
            <input id="f_type_free" placeholder="or new type" style="flex:2">
          </span>
        </label>
        <button class="primary" type="submit">Create node</button>
        <div class="dim" style="font-size:11px">
          Tags are the model's job — create it here, let an agent classify it.
          Anything unclassified shows in <a href="#/untagged">untagged</a>.
        </div>
        <div id="formMsg" class="msg dim"></div>
      </form>
    </section>

    <section>
      <h2>
        <span>Organization</span>
        <button class="ghost" id="toggleTaxForm" type="button">+ new</button>
      </h2>

      <form id="taxForm" hidden>
        <div class="row">
          <label class="field">vocabulary
            <input id="v_name" placeholder="topics" required>
          </label>
          <label class="field">kind
            <select id="v_kind">
              <option value="tags">tags (free)</option>
              <option value="categories">categories (controlled)</option>
            </select>
          </label>
        </div>
        <div class="row">
          <label class="field">term (optional)
            <input id="t_name" placeholder="mcp">
          </label>
          <label class="field">weight
            <input id="t_weight" type="number" value="0" style="min-width:74px">
          </label>
        </div>
        <button type="submit">Create</button>
        <div id="taxMsg" class="msg dim"></div>
      </form>

      <div id="filterBar" class="row" style="margin-bottom:9px" hidden>
        <span class="dim mono" id="filterCount" style="flex:1"></span>
        <select id="matchMode" style="flex:0 0 auto" title="all = every tag (AND). any = at least one (OR).">
          <option value="any">any</option>
          <option value="all">all</option>
        </select>
        <button class="ghost" id="clearFilter" type="button" style="flex:0 0 auto">clear</button>
      </div>

      <div id="taxonomy"><span class="dim">loading...</span></div>
    </section>

    <section>
      <h2>
        <span>Corpus</span>
        <a class="mono" href="#/untagged" id="untaggedLink"></a>
      </h2>
      <div class="stats" id="stats"></div>
    </section>
  </aside>

  <main>
    <section>
      <h2 id="listHeading">Content</h2>
      <div id="nodes"><span class="dim">loading...</span></div>
    </section>

    <section>
      <h2>MCP call log</h2>
      <div id="calls"><span class="dim">loading...</span></div>
    </section>
  </main>
</div>

<script type="module">
const NL = String.fromCharCode(10);

const j = async (url, opts) => {
  const response = await fetch(url, opts);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || body?.summary || body?.error || ("HTTP " + response.status));
  return body;
};
const post = (url, data) =>
  j(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const when = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };
const say = (el, text, kind) => { el.className = "msg " + (kind || "dim"); el.textContent = text; };

// ── state ───────────────────────────────────────────────────────────────────
// Selected tags live in the URL, so a filtered view is shareable and survives a
// reload: #/terms/id1,id2/all
let taxonomy = { vocabularies: [], terms: [] };
let selected = new Set();
let matchMode = "any";

function readRoute() {
  const parts = location.hash.slice(2).split("/");
  if (parts[0] === "terms" && parts[1]) {
    selected = new Set(decodeURIComponent(parts[1]).split(",").filter(Boolean));
    matchMode = parts[2] === "all" ? "all" : "any";
  } else if (parts[0] !== "q") {
    selected = new Set();
  }
  return { kind: parts[0] || "", value: decodeURIComponent(parts.slice(1).join("/") || "") };
}

const writeTermRoute = () => {
  location.hash = selected.size
    ? "#/terms/" + encodeURIComponent([...selected].join(",")) + "/" + matchMode
    : "#/";
};

// ── the call log, as YAML ───────────────────────────────────────────────────
function toYaml(value, indent = 0) {
  const pad = "  ".repeat(indent);
  if (value === null) return "~";
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return value.map(item => {
      const rendered = toYaml(item, indent + 1);
      return rendered.includes(NL) ? pad + "-" + NL + rendered : pad + "- " + rendered.trim();
    }).join(NL);
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) return "{}";
    return keys.map(key => {
      const child = value[key];
      const isBranch = child && typeof child === "object";
      const rendered = toYaml(child, indent + 1);
      const label = pad + '<span class="k">' + esc(key) + ":</span>";
      return isBranch && rendered.includes(NL) ? label + NL + rendered
                                               : label + " " + esc(String(rendered).trim());
    }).join(NL);
  }
  const text = String(value);
  return text.includes(NL) ? text.split(NL).map(line => pad + line).join(NL).trim() : text;
}

function tryParse(raw) {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

function summarise(raw) {
  const parsed = tryParse(raw);
  if (parsed === undefined) return raw.length > 60 ? raw.slice(0, 60) + "..." : raw;
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.nodes)) return parsed.nodes.length + " node(s)" + (parsed.mode ? " - " + parsed.mode : "");
    if (Array.isArray(parsed.calls)) return parsed.calls.length + " call(s)";
    if (Array.isArray(parsed.types)) return parsed.types.length + " type(s) - " + parsed.policy;
    if (Array.isArray(parsed.terms) && !parsed.id) return parsed.terms.length + " term(s)";
    if (parsed.title) return parsed.title;
    if (parsed.deleted) return "deleted " + parsed.deleted;
    return Object.keys(parsed).slice(0, 3).map(k => k + "=" + JSON.stringify(parsed[k])).join(" ").slice(0, 70);
  }
  return String(parsed).slice(0, 70);
}

const yamlCell = (raw) => {
  const parsed = tryParse(raw);
  if (parsed === undefined) return '<span class="mono wrap dim">' + esc(raw) + "</span>";
  return '<details class="yaml"><summary>' + esc(summarise(raw)) + "</summary><pre>" + toYaml(parsed) + "</pre></details>";
};

// ── the tag cloud ───────────────────────────────────────────────────────────
/**
 * Size by usage, on a LOG scale between 11px and 20px.
 *
 * Linear sizing looks right until one tag runs away: with counts of 1 and 40,
 * a linear map makes every other tag identically tiny and the cloud stops
 * carrying information. Log compresses the tail, which is the whole reason
 * tag clouds traditionally use it.
 *
 * Unused terms are not hidden — a term with 0 nodes is a real part of a
 * controlled vocabulary and hiding it would make a fresh vocabulary look empty.
 * They are dimmed instead.
 */
function cloudSize(usage, max) {
  if (!max || usage <= 0) return 11;
  const ratio = Math.log(1 + usage) / Math.log(1 + max);
  return (11 + ratio * 9).toFixed(1);
}

// ── rendering ───────────────────────────────────────────────────────────────
async function renderTaxonomy() {
  const [v, t] = await Promise.all([j("/api/vocabularies"), j("/api/terms")]);
  taxonomy = { vocabularies: v.vocabularies || [], terms: t.terms || [] };

  const byVocab = new Map(taxonomy.vocabularies.map(x => [x.id, { ...x, terms: [] }]));
  for (const term of taxonomy.terms) byVocab.get(term.vocabulary_id)?.terms.push(term);
  const groups = [...byVocab.values()].filter(g => g.terms.length);
  const maxUsage = Math.max(1, ...taxonomy.terms.map(t => t.usage || 0));

  // Categories and tags render differently on purpose — that is the Drupal
  // distinction made visible. A controlled vocabulary in weight order is a
  // MENU; a free-tagging one is a CLOUD sized by how much it is actually used.
  const block = (g) => {
    const isMenu = g.kind === "categories";
    return '<div class="vocab"><b>' + esc(g.label || g.name) +
      '<span class="kind">' + (isMenu ? "menu" : "cloud") + "</span></b>" +
      '<div class="' + (isMenu ? "menu" : "cloud") + '">' +
      g.terms.map(term => {
        const usage = term.usage || 0;
        const style = isMenu ? "" : ' style="font-size:' + cloudSize(usage, maxUsage) + 'px"';
        const unused = !isMenu && usage === 0 ? " unused" : "";
        return '<span class="term' + unused + '" data-term="' + esc(term.id) + '"' + style +
          ' role="button" aria-pressed="' + selected.has(term.id) + '" title="' + usage + ' node(s)">' +
          esc(term.name) + '<span class="n">' + usage + "</span></span>";
      }).join("") + "</div></div>";
  };

  document.getElementById("taxonomy").innerHTML = groups.length
    ? groups.filter(g => g.kind === "categories").map(block).join("") +
      groups.filter(g => g.kind !== "categories").map(block).join("")
    : '<div class="empty">No terms yet — use "+ new" above.</div>';

  for (const el of document.querySelectorAll("#taxonomy .term")) {
    el.onclick = () => {
      // Multi-select: click to add, click again to remove. AND/OR is the
      // caller's choice, and the heading echoes which one ran.
      selected.has(el.dataset.term) ? selected.delete(el.dataset.term) : selected.add(el.dataset.term);
      writeTermRoute();
    };
  }

  const bar = document.getElementById("filterBar");
  bar.hidden = selected.size === 0;
  document.getElementById("filterCount").textContent = selected.size + " tag(s) selected";
  document.getElementById("matchMode").value = matchMode;

}

function renderNodes(nodes, heading) {
  document.getElementById("listHeading").textContent = heading;
  document.getElementById("nodes").innerHTML = nodes.length
    ? nodes.map(n => "<article><h3>" + esc(n.title) + (n.status ? "" : ' <span class="pill">draft</span>') + "</h3>" +
        '<div class="meta"><span class="pill">' + esc(n.type) + "</span>" +
        '<span class="mono num">' + when(n.created_at) + "</span>" +
        (typeof n.score === "number" ? '<span class="mono num">' + n.score.toFixed(3) + "</span>" : "") +
        (Array.isArray(n.found_by) ? '<span class="mono dim">' + esc(n.found_by.join("+")) + "</span>" : "") +
        (Array.isArray(n.terms)
          ? n.terms.map(t => '<span class="pill tag" data-term="' + esc(t.id) +
              '" role="button" title="filter by this tag">' + esc(t.name) + "</span>").join("")
          : "") +
        '<button class="ghost" data-del="' + esc(n.id) + '">delete</button></div>' +
        (n.body ? "<p>" + esc(n.body) + "</p>" : "") + "</article>").join("")
    : '<div class="empty">Nothing here.</div>';

  // A tag printed on a node is a way INTO that tag, not decoration.
  for (const el of document.querySelectorAll("#nodes .pill.tag[data-term]")) {
    el.onclick = () => {
      selected.has(el.dataset.term) ? selected.delete(el.dataset.term) : selected.add(el.dataset.term);
      writeTermRoute();
    };
  }

  for (const el of document.querySelectorAll("[data-del]")) {
    el.onclick = async () => {
      if (!confirm("Delete this node permanently?")) return;
      await j("/api/nodes/" + el.dataset.del, { method: "DELETE" });
      load();
    };
  }
}

async function loadList() {
  const route = readRoute();
  if (selected.size) {
    const params = new URLSearchParams({ term_ids: [...selected].join(","), match: matchMode, limit: "50" });
    const res = await j("/api/nodes?" + params);
    const names = [...selected].map(id => (taxonomy.terms.find(t => t.id === id) || {}).name || id);
    renderNodes(res.nodes, "Tagged " + names.join(matchMode === "all" ? " AND " : " OR ") + " - " + res.count);
  } else if (route.kind === "untagged") {
    const res = await j("/api/nodes?untagged=1&limit=50");
    renderNodes(res.nodes, "Untagged - " + res.count + " waiting to be classified");
  } else if (route.kind === "q" && route.value) {
    const mode = document.getElementById("searchMode").value;
    const params = new URLSearchParams({ q: route.value, mode, limit: "50" });
    const res = await j("/api/nodes?" + params);
    // Mode and coverage are shown, never implied: "like" means a substring scan,
    // and a semantic score over a half-embedded corpus is a coverage fact.
    renderNodes(res.nodes, 'Search "' + route.value + '" - ' + res.count + " hit(s) - mode: " + res.mode +
      (res.coverage ? " - " + res.coverage : ""));
  } else {
    const res = await j("/api/nodes?limit=50");
    renderNodes(res.nodes, "Content");
  }
}

async function loadRest() {
  const [health, stats, types, calls] = await Promise.all([
    j("/health"), j("/api/stats"), j("/api/types"), j("/api/calls?limit=20"),
  ]);

  document.getElementById("health").textContent =
    "v" + health.version + " - " + health.driver + " - auth: " + health.auth +
    " - " + health.tools + " tools" + (health.embedder ? " - embedder on" : " - no embedder");

  // Surfaced as a link, because it is a queue somebody (or something) works.
  const untagged = await j("/api/nodes?untagged=1&limit=100");
  const link = document.getElementById("untaggedLink");
  link.textContent = untagged.count ? untagged.count + " untagged" : "";
  link.className = untagged.count ? "mono bad" : "mono dim";

  document.getElementById("stats").innerHTML = [
    ["nodes", stats.nodes], ["published", stats.published],
    ["embedded", (stats.embedding || {}).embedded ?? 0],
    ["vocabs", (stats.vocabularies || []).length],
  ].map(([k, v]) => '<div class="stat"><b>' + (v ?? 0) + "</b><span>" + k + "</span></div>").join("");

  // The type control follows the POLICY: controlled means pick from the list,
  // free means anything goes.
  const select = document.getElementById("f_type_select");
  select.innerHTML = types.types.map(t =>
    '<option value="' + esc(t.type) + '">' + esc(t.type) + " (" + t.count + ")</option>").join("");
  document.getElementById("f_type_free").hidden = types.policy === "controlled";

  document.getElementById("calls").innerHTML = (calls.calls || []).length
    ? '<table><thead><tr><th>when</th><th>tool</th><th>input</th><th>result</th><th class="num">ms</th></tr></thead><tbody>' +
      calls.calls.map(c => "<tr>" +
        '<td class="mono num dim">' + when(c.called_at) + "</td>" +
        '<td class="mono ' + (c.outcome === "error" ? "bad" : "ok") + '">' + esc(c.tool) + "</td>" +
        "<td>" + yamlCell(c.input) + "</td><td>" + yamlCell(c.result) + "</td>" +
        '<td class="mono num">' + c.duration_ms + "</td></tr>").join("") + "</tbody></table>"
    : '<div class="empty">No MCP calls logged yet.</div>';
}

async function load() {
  try {
    readRoute();
    await renderTaxonomy();
    await Promise.all([loadList(), loadRest()]);
  } catch (error) {
    document.getElementById("nodes").innerHTML = '<div class="empty bad">' + esc(error.message) + "</div>";
  }
}

// ── forms ───────────────────────────────────────────────────────────────────
document.getElementById("createForm").onsubmit = async (event) => {
  event.preventDefault();
  const msg = document.getElementById("formMsg");
  const free = document.getElementById("f_type_free");
  try {
    say(msg, "saving...");
    await post("/api/nodes", {
      title: document.getElementById("f_title").value,
      body: document.getElementById("f_body").value,
      type: (free.hidden ? "" : free.value.trim()) || document.getElementById("f_type_select").value || undefined,
    });
    event.target.reset();
    say(msg, "saved", "ok");
    setTimeout(() => say(msg, ""), 2000);
    load();
  } catch (error) {
    // The server's refusal is shown verbatim — a controlled vocabulary's error
    // lists what IS allowed, which is the useful half of it.
    say(msg, error.message, "bad");
  }
};

document.getElementById("toggleTaxForm").onclick = () => {
  const form = document.getElementById("taxForm");
  form.hidden = !form.hidden;
};

document.getElementById("taxForm").onsubmit = async (event) => {
  event.preventDefault();
  const msg = document.getElementById("taxMsg");
  const name = document.getElementById("v_name").value.trim();
  const kind = document.getElementById("v_kind").value;
  const term = document.getElementById("t_name").value.trim();
  try {
    say(msg, "saving...");
    await post("/api/vocabularies", { name, kind });
    if (term) {
      await post("/api/terms", {
        vocabulary: name, name: term,
        weight: Number(document.getElementById("t_weight").value) || 0,
      });
    }
    say(msg, term ? "vocabulary + term created" : "vocabulary created", "ok");
    document.getElementById("t_name").value = "";
    load();
  } catch (error) {
    say(msg, error.message, "bad");
  }
};

document.getElementById("q").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const value = event.target.value.trim();
  selected = new Set();
  location.hash = value ? "#/q/" + encodeURIComponent(value) : "#/";
});
document.getElementById("searchMode").onchange = () => { if (location.hash.startsWith("#/q/")) load(); };
document.getElementById("matchMode").onchange = (event) => { matchMode = event.target.value; writeTermRoute(); };
document.getElementById("clearFilter").onclick = () => { selected = new Set(); writeTermRoute(); };

addEventListener("hashchange", load);
load();
setInterval(loadRest, 15000);
</script>
</body>
</html>`;
}

function escapeHtml(input: string): string {
  return String(input).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
