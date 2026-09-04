/**
 * The two screens a human sees before reaching the corpus: the OAuth consent
 * page and the owner lock screen.
 *
 * They live together, apart from page.ts, for one reason — neither may contain
 * client-side JavaScript. These are the surfaces where a failure means "cannot
 * get in at all", with no working UI left to debug against; a plain form POST
 * cannot be broken by a script error, a CSP, or a stray newline in a template
 * literal (which is exactly how page.ts's own client JS broke once).
 */

import { escapeHtml } from "./utils";

const SHELL = `
  /*
    The same warm, lamp-lit world as the app.
    
    These screens were left on the old blue-slate palette when the app moved,
    which made the FIRST thing any visitor loads the one thing that did not look
    like the product. An entry screen that disagrees with what is behind it reads
    as two different pieces of software.
  */
  :root {
    --ground:#16130f; --panel:#1e1a15; --line:#312a22; --ink:#efe7da;
    --dim:#a99e8d; --ember:#e0a458; --clay:#e58e7c;
    --lamp: radial-gradient(50rem 20rem at 50% -6rem, rgba(224,164,88,.12), transparent 70%);
    color-scheme: dark;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --ground:#f7f2e7; --panel:#fffdf8; --line:#e6dcc8; --ink:#2b2419;
      --dim:#6f6453; --ember:#a2621d; --clay:#a5482f;
      --lamp: radial-gradient(50rem 20rem at 50% -6rem, rgba(162,98,29,.09), transparent 70%);
      color-scheme: light;
    }
  }
  * { box-sizing: border-box; }
  body { font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: var(--lamp), var(--ground); color: var(--ink); padding: 24px; }
  form { width: 100%; max-width: 26rem; background: var(--panel);
         border: 1px solid var(--line); border-radius: 14px; padding: 28px;
         box-shadow: 0 1px 2px rgba(20,14,6,.20), 0 8px 24px -12px rgba(20,14,6,.45); }
  h1 { font-size: 1.05rem; margin: 0 0 4px; letter-spacing: .01em; }
  p  { color: var(--dim); margin: 0 0 20px; font-size: .9rem; }
  .strong { color: var(--ink); font-weight: 600; }
  label { display: block; font-size: .8rem; color: var(--dim); margin-bottom: 6px; }
  input[type=password] { width: 100%; padding: 10px 12px; border-radius: 9px;
    border: 1px solid var(--line); background: var(--ground); color: var(--ink);
    font-size: .95rem; caret-color: var(--ember); }
  input[type=password]:focus { outline: none; border-color: color-mix(in oklab, var(--ember) 60%, var(--line));
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--ember) 22%, transparent); }
  button { margin-top: 16px; width: 100%; padding: 11px; border: 0; border-radius: 9px;
    background: var(--ember); color: var(--ground); font-size: .95rem; font-weight: 600;
    cursor: pointer; transition: filter .15s; }
  button:hover { filter: brightness(1.08); }
  .err { background: color-mix(in oklab, var(--clay) 14%, var(--panel));
         border: 1px solid color-mix(in oklab, var(--clay) 45%, var(--line));
         color: var(--clay); padding: 9px 12px; border-radius: 9px;
         font-size: .85rem; margin-bottom: 16px; }
  .meta { margin: 0 0 20px; font-size: .78rem; color: var(--dim); }
  ::selection { background: color-mix(in oklab, var(--ember) 30%, transparent); color: var(--ink); }
  :focus-visible { outline: 2px solid var(--ember); outline-offset: 2px; }
`;

const shell = (title: string, form: string): string => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${SHELL}</style></head>
<body>${form}</body></html>`;

/**
 * The OAuth consent screen — the only human step in the flow.
 *
 * There is no account system behind this: the owner passphrase IS the
 * authorization decision. Every OAuth parameter is echoed back as a hidden
 * field, because this form POSTs to /authorize and the code cannot be issued
 * without them.
 */
export function approvalPage(input: {
  clientName: string;
  params: Record<string, string>;
  error?: string;
}): string {
  const hidden = Object.entries(input.params)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
    .join("");

  return shell(
    "Authorize · digger-node",
    `<form method="post" action="/authorize">
  <h1>Connect <span class="strong">${escapeHtml(input.clientName)}</span></h1>
  <p>It is asking to read and write this corpus.</p>
  ${input.error ? `<div class="err">${escapeHtml(input.error)}</div>` : ""}
  <div class="meta">Scope: ${escapeHtml(input.params.scope || "")}</div>
  <label for="passphrase">Owner passphrase</label>
  <input id="passphrase" type="password" name="passphrase" autocomplete="current-password" autofocus required>
  ${hidden}
  <button type="submit">Approve</button>
</form>`,
  );
}

/** The lock screen for the web page. Same passphrase, different destination. */
export function loginPage(input: { instanceName: string; error?: string; next?: string }): string {
  return shell(
    `Sign in · ${input.instanceName}`,
    `<form method="post" action="/login">
  <h1>${escapeHtml(input.instanceName)}</h1>
  <p>This corpus is private. Enter the owner passphrase.</p>
  ${input.error ? `<div class="err">${escapeHtml(input.error)}</div>` : ""}
  <label for="passphrase">Owner passphrase</label>
  <input id="passphrase" type="password" name="passphrase" autocomplete="current-password" autofocus required>
  ${input.next ? `<input type="hidden" name="next" value="${escapeHtml(input.next)}">` : ""}
  <button type="submit">Sign in</button>
</form>`,
  );
}
