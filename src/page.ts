/**
 * The web page: a real .html file, imported as text.
 *
 * It used to be a TypeScript template literal holding the markup, the CSS and
 * the client JS. That cost a production bug worth recording: a literal `\n`
 * written inside the client code became an ACTUAL newline when the template was
 * evaluated, cutting a JS string in half. Every route still answered 200 and the
 * page was inert — the failure had no error and no logs. The workaround was
 * `NL = String.fromCharCode(10)`, which worked, and was a splint on a broken
 * bone: the next thing to break would have been the first backtick the client
 * needed, which is exactly what htm's tagged templates are made of.
 *
 * `import ... with { type: "text" }` is supported by both runtimes this project
 * targets — verified against `bun` 1.3 and `wrangler deploy --dry-run` before
 * being relied on — so the client can live in a file where a backtick is a
 * backtick and an editor knows it is looking at HTML.
 */

// @ts-ignore — the import attribute is understood by bun and by wrangler's
// bundler; TS has no lib type for it here.
import template from "./page.html" with { type: "text" };

/**
 * Substituted rather than templated.
 *
 * The instance name is the only server-side value the page needs, and a single
 * marker keeps page.html a file that opens correctly in a browser and an editor.
 * Escaped because an instance name is operator-supplied.
 */
export function page(instance: string): string {
  return (template as unknown as string).replaceAll("__INSTANCE__", escapeHtml(instance));
}

function escapeHtml(input: string): string {
  return String(input).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}
