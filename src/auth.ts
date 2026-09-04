/**
 * One gate, three keys — and an honest fourth state where the gate is open.
 *
 * Different callers can prove themselves in different ways, and no single
 * mechanism serves them all:
 *
 *   oauth          claude.ai connectors. They cannot send a static header at
 *                  all, so OAuth is the only door open to them. This is the
 *                  entire reason oauth.ts exists.
 *   api-token      curl, scripts, Claude Code, a Tauri client — anything that
 *                  reads a config file and CAN send a static header, and for
 *                  which the OAuth dance would be ceremony with no benefit.
 *   owner-session  the web page. A browser has cookies and cannot hold a bearer
 *                  token without script keeping it somewhere readable.
 *   open           nothing configured. Documented below, and reported by
 *                  /health on every call rather than left to be inferred.
 *
 * All keys open the same corpus with the same rights. The distinction is how the
 * caller proved it is the owner, not what it may then do — scopes are recorded
 * on the token because the spec asks for them, and are deliberately not enforced
 * as a permission split. One owner does not need to be protected from itself,
 * and a permission system nobody exercises is a bug farm, not a boundary.
 */

import { SCOPES, verifyBearer } from "./oauth";
import { SESSION_COOKIE_NAME, verifySession } from "./session";
import type { Store } from "./store/types";
import { readCookie, timingSafeEqual } from "./utils";

export type AuthMethod = "open" | "owner-session" | "api-token" | "oauth";

export interface AuthConfig {
  /** Enables OAuth and the web login. Without it there is no way to approve a
   *  client, so the OAuth endpoints refuse rather than pretend. */
  ownerPassphrase?: string;
  /** Enables a static bearer for scripts and local MCP clients. */
  apiToken?: string;
}

export interface AuthResult {
  ok: boolean;
  method?: AuthMethod;
  clientId?: string;
  scope?: string;
}

const DENIED: AuthResult = { ok: false };
const OPEN: AuthResult = { ok: true, method: "open" };

/**
 * Whether this deployment has any credential at all.
 *
 * With neither secret set the server stays open — the same behaviour it had
 * before this file existed. That is a deliberate choice for a one-click install:
 * a deploy button that produces a Worker returning 401 to its own owner, with no
 * way to set a secret from the same screen, is a broken first run. The cost is
 * real and must not be hidden, so it is stated in /health, in the README, and on
 * the page itself.
 */
export function authEnabled(config: AuthConfig): boolean {
  return Boolean(config.ownerPassphrase?.trim() || config.apiToken?.trim());
}

/** What /health reports. Never the secrets — only which doors exist. */
export function authModes(config: AuthConfig): string[] {
  const modes: string[] = [];
  if (config.apiToken?.trim()) modes.push("api-token");
  if (config.ownerPassphrase?.trim()) modes.push("oauth", "owner-session");
  return modes;
}

export async function authenticate(
  store: Store,
  request: Request,
  config: AuthConfig,
  /**
   * The RFC 8707 audience this request is being made against — for the MCP
   * endpoint, `<origin>/mcp`. Passed only where there is a resource to check
   * against; a token recorded for one resource must not open another.
   */
  expectedResource?: string,
): Promise<AuthResult> {
  if (!authEnabled(config)) return OPEN;

  const authorization = request.headers.get("authorization");

  if (authorization) {
    // Scheme match is case-insensitive per RFC 7235; a client sending "bearer"
    // is compliant and must not be rejected as anonymous.
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (!match) return DENIED;
    const presented = match[1].trim();
    if (!presented) return DENIED;

    // Static token first: one comparison, against the OAuth path's database
    // round trip. Constant-time, because `===` on a secret leaks how much of it
    // was right.
    if (config.apiToken?.trim() && (await timingSafeEqual(presented, config.apiToken.trim()))) {
      return { ok: true, method: "api-token" };
    }

    if (config.ownerPassphrase?.trim()) {
      const token = await verifyBearer(store, presented, expectedResource);
      if (token) {
        return { ok: true, method: "oauth", clientId: token.clientId, scope: token.scope };
      }
    }

    // A Bearer header that matched neither is a definite no. Falling through to
    // the cookie here would let an expired token ride an open browser session
    // and report the wrong method in the call log.
    return DENIED;
  }

  const cookie = readCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME);
  if (await verifySession(config.ownerPassphrase, cookie)) {
    return { ok: true, method: "owner-session" };
  }

  return DENIED;
}

/**
 * The 401 that starts the OAuth dance.
 *
 * `WWW-Authenticate` carries the RFC 9728 resource-metadata pointer an MCP
 * client follows to discover where /authorize lives. Without this header
 * claude.ai has no way to learn this server even has an authorization server,
 * and reports nothing more useful than a failed connection.
 *
 * The CORS headers are not decoration: the 401 is a cross-origin response like
 * any other, and a browser-side client that cannot READ the header learns
 * nothing from receiving it.
 */
export function unauthorized(origin: string, description = "Missing or invalid access token"): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized", error_description: description }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        // The parameter order and set follow the canonical form in Claude's own
        // connector documentation. `scope` is included because a client is
        // entitled to learn what it should ASK for from the challenge itself,
        // rather than having to fetch the metadata document to find out.
        "www-authenticate":
          `Bearer realm="digger-node", ` +
          `error="invalid_token", ` +
          `error_description="${description}", ` +
          `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", ` +
          `scope="${SCOPES.join(" ")}"`,
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "www-authenticate",
      },
    },
  );
}
