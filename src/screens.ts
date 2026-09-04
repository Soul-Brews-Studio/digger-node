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
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #0f1115; color: #e6e6e6; padding: 24px; }
  form { width: 100%; max-width: 26rem; background: #171a21; border: 1px solid #262b36;
         border-radius: 14px; padding: 28px; }
  h1 { font-size: 1.05rem; margin: 0 0 4px; letter-spacing: .01em; }
  p  { color: #9aa3b2; margin: 0 0 20px; font-size: .9rem; }
  .strong { color: #e6e6e6; font-weight: 600; }
  label { display: block; font-size: .8rem; color: #9aa3b2; margin-bottom: 6px; }
  input[type=password] { width: 100%; padding: 10px 12px; border-radius: 9px;
    border: 1px solid #2c323f; background: #0f1115; color: #e6e6e6; font-size: .95rem; }
  button { margin-top: 16px; width: 100%; padding: 11px; border: 0; border-radius: 9px;
    background: #4f7cff; color: #fff; font-size: .95rem; font-weight: 600; cursor: pointer; }
  .err { background: #2a1416; border: 1px solid #5b2126; color: #ffb4b4;
         padding: 9px 12px; border-radius: 9px; font-size: .85rem; margin-bottom: 16px; }
  .meta { margin: 0 0 20px; font-size: .78rem; color: #6f7889; }
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
