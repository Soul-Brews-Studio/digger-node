/**
 * Authentication as one Elysia plugin: the gate, the OAuth endpoints, and the
 * browser's login, mounted with a single `.use()`.
 *
 * Why a plugin rather than routes inlined in app.ts:
 *
 *   - The endpoints and the gate that protects everything else cannot be
 *     mounted separately. Half of this feature — discovery documents and a
 *     token endpoint with nothing actually guarded — is worse than none, and
 *     a plugin makes that combination impossible to assemble by accident.
 *   - app.ts stays about the corpus. Twelve OAuth routes in the middle of the
 *     content API is how the one file anyone reads to understand the product
 *     stops being readable.
 *   - It is portable. The Tauri build that store/sqlite.ts exists for gets the
 *     same auth by using the same plugin, with no copied code to drift.
 *
 * THE SCOPE TRAP, stated up front because it is the one that bites:
 * an Elysia lifecycle hook registered inside a plugin is LOCAL by default — it
 * runs for routes declared in the plugin and NOT for routes in the parent that
 * mounted it. A gate with default scope would therefore protect the OAuth
 * endpoints (which need no protection) and leave /mcp and /api/* wide open,
 * silently, with every test that only exercises the plugin still passing. Hence
 * `{ as: "global" }` below, and hence `test/auth.test.ts` asserting that a
 * PARENT route 401s — the assertion exists to catch this exact regression, not
 * to restate the obvious.
 */

import { Elysia } from "elysia";

import { authenticate, authEnabled, unauthorized, type AuthConfig } from "./auth";
import * as oauth from "./oauth";
import { checkOwner, clearPassphrase, MIN_PASSPHRASE, readStored, setPassphrase } from "./passphrase";
import { clientIp, recordFailure, recordSuccess, retryAfter, tooManyAttempts } from "./ratelimit";
import { approvalPage, loginPage } from "./screens";
import { clearedSessionCookie, issueSession, sessionCookie } from "./session";
import type { Store } from "./store/types";
import { timingSafeEqual } from "./utils";

export interface AuthPluginOptions {
  store: Store;
  auth?: AuthConfig;
  /** Throttle the passphrase endpoints. Defaults ON whenever auth is on — the
   *  deployment that most needs a guessing budget is the one nobody
   *  configured. See ratelimit.ts for when turning it off is reasonable. */
  rateLimit?: boolean;
  /** Overrides the origin advertised in OAuth metadata. Only needed behind a
   *  proxy that rewrites Host — see oauth.ts on why this must be exact. */
  publicUrl?: string;
  instanceName?: string;
}

/**
 * Paths that must answer before a caller has any credential.
 *
 * An allow-list, not a deny-list: a route added later is protected by default,
 * and forgetting to list one costs a 401 rather than an open door. Each entry
 * earns its place —
 *
 *   /health                 an operator must be able to see the server is up,
 *                           and its body carries no corpus content.
 *   /.well-known/*          the discovery documents, fetched BEFORE a client
 *                           has a token. Protecting them would make the OAuth
 *                           flow undiscoverable — a 401 pointing at a 401.
 *   /oauth/register|token   the flow itself, protected by its own logic (PKCE,
 *                           single-use codes) rather than by this gate.
 *   /authorize              carries the owner passphrase in its own POST body.
 *   /login, /logout         the browser's way in and out.
 *   /                       serves the lock screen rather than a bare 401,
 *                           which a browser renders as a blank page.
 */
const PUBLIC_PATHS = new Set([
  "/health",
  "/oauth/register",
  "/oauth/token",
  "/authorize",
  "/login",
  "/logout",
  "/",
]);

export const isPublicPath = (pathname: string): boolean =>
  PUBLIC_PATHS.has(pathname) || pathname.startsWith("/.well-known/");

/**
 * Whether THIS request arrived over TLS — not whether a public HTTPS URL is
 * configured.
 *
 * Conflating those silently breaks login: the browser refuses to store a
 * `Secure` cookie over plain http, so a correct passphrase returns 302, no
 * cookie is kept, and the next page is the lock screen again — which reads to
 * the user as "wrong password" while the logs show a successful login.
 */
const isSecureRequest = (request: Request): boolean =>
  new URL(request.url).protocol === "https:" ||
  request.headers.get("x-forwarded-proto") === "https";

export function authPlugin({
  store,
  auth = {},
  publicUrl,
  instanceName = "digger-node",
  rateLimit,
}: AuthPluginOptions) {
  const guarded = authEnabled(auth);
  const throttled = rateLimit ?? guarded;

  /**
   * The key the session cookie is signed with.
   *
   * It folds in the STORED passphrase hash, not just the env secret, so that
   * changing the passphrase from the UI invalidates every outstanding session —
   * on every device. Signing with the env secret alone would mean "change the
   * lock" left the old keys working, which is the opposite of what the button
   * says it does.
   */
  const sessionKey = async () => {
    const stored = await readStored(store);
    return (auth.ownerPassphrase ?? "") + "\u0000" + (stored ?? "");
  };

  /** 0 when the caller may try. One branch, so "is throttling on?" is answered
   *  in one place rather than at each call site. */
  const wait = (request: Request, bucket: "login" | "authorize") =>
    throttled ? retryAfter(store, bucket, clientIp(request)) : Promise.resolve(0);
  const origin = (request: Request) => oauth.originOf(request, publicUrl);

  // A `name` makes this plugin deduplicated by Elysia: mounting it twice
  // registers one copy of the hook rather than running the gate twice.
  return (
    new Elysia({ name: "digger-auth", aot: false })

      /**
       * The gate. `as: "global"` is load-bearing — see the scope trap above.
       *
       * One hook rather than a wrapper per route: a route that forgets to
       * authenticate is the bug this cannot afford, and an allow-list checked
       * in one place is auditable in a way twenty decorated handlers are not.
       *
       * With no secrets configured this returns immediately and the server
       * behaves exactly as it did before auth existed.
       */
      .onBeforeHandle({ as: "global" }, async ({ request }) => {
        if (!guarded) return;
        if (request.method === "OPTIONS") return;
        const { pathname } = new URL(request.url);
        if (isPublicPath(pathname)) return;

        // The audience a token must have been issued for, when it carries one.
        const result = await authenticate(store, request, auth, `${origin(request)}/mcp`, await sessionKey());
        // Returning a Response short-circuits the route. It carries its own
        // CORS headers because onAfterHandle does not run on this path, and a
        // 401 a browser cannot read teaches a client nothing — this particular
        // 401 is the first step of the OAuth flow.
        if (!result.ok) return unauthorized(origin(request));
      })

      // ── discovery ──────────────────────────────────────────────────────────
      // Served unconditionally, even with OAuth switched off. A client that
      // fetches these on an open server learns the endpoints exist and then
      // gets a 200 from /mcp without a token, which is the truth. Hiding them
      // when unconfigured would make "is OAuth available here?" unanswerable.
      .get("/.well-known/oauth-authorization-server", ({ request }) =>
        oauth.authorizationServerMetadata(origin(request)),
      )
      /**
       * The OIDC alias for the same document.
       *
       * Not because this is an OpenID provider — it is not. A spec-compliant
       * MCP client that gets a 404 from the RFC 8414 path is required to try
       * this one next, and a client that reaches it and 404s again stops. It is
       * the identical body at a second URL: the cheapest possible insurance
       * against a discovery chain that dead-ends.
       */
      .get("/.well-known/openid-configuration", ({ request }) =>
        oauth.authorizationServerMetadata(origin(request)),
      )
      /**
       * RFC 9728 locates a protected resource's metadata by appending the
       * resource's PATH to the well-known prefix. For an MCP endpoint at /mcp
       * that is /.well-known/oauth-protected-resource/mcp — the bare path is
       * the form for a resource at the origin root. Both are served: the
       * suffixed one because it is correct, the bare one because clients ask
       * for it anyway.
       */
      .get("/.well-known/oauth-protected-resource", ({ request }) =>
        oauth.protectedResourceMetadata(origin(request)),
      )
      .get("/.well-known/oauth-protected-resource/mcp", ({ request }) =>
        oauth.protectedResourceMetadata(origin(request)),
      )

      // ── dynamic client registration ────────────────────────────────────────
      .post("/oauth/register", async ({ body, set }) => {
        if (!auth.ownerPassphrase?.trim()) {
          // 501, not 404: the endpoint exists and is unconfigured, which is a
          // different problem for whoever is debugging it than a wrong URL.
          set.status = 501;
          return {
            error: "oauth_not_configured",
            error_description: "Set the OWNER_PASSPHRASE secret to enable OAuth.",
          };
        }
        try {
          const client = await oauth.registerClient(
            store,
            (body ?? {}) as { client_name?: string; redirect_uris?: string[] },
          );
          set.status = 201;
          return {
            client_id: client.clientId,
            client_name: client.clientName,
            redirect_uris: client.redirectUris,
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code"],
            response_types: ["code"],
          };
        } catch (error) {
          set.status = 400;
          return {
            error: "invalid_client_metadata",
            error_description: error instanceof Error ? error.message : "invalid",
          };
        }
      })

      // ── the approval page ──────────────────────────────────────────────────
      .get("/authorize", async ({ query, request }) => {
        if (!auth.ownerPassphrase?.trim()) {
          return new Response("OAuth is not configured on this deployment.", {
            status: 501,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }

        const clientId = String(query.client_id ?? "");
        const redirectUri = String(query.redirect_uri ?? "");
        const client = await oauth.getClient(store, clientId);

        // Never redirect on an unknown client or an unregistered redirect_uri.
        // Redirecting here IS the open redirect that the exact-match check
        // exists to prevent, so the failure stays on our own page.
        if (!client || !oauth.isRegisteredRedirect(client, redirectUri)) {
          return new Response("Unknown client or unregistered redirect_uri.", {
            status: 400,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }

        return new Response(
          approvalPage({
            clientName: client.clientName ?? client.clientId,
            params: {
              client_id: clientId,
              redirect_uri: redirectUri,
              state: String(query.state ?? ""),
              code_challenge: String(query.code_challenge ?? ""),
              code_challenge_method: String(query.code_challenge_method ?? ""),
              scope: String(query.scope ?? oauth.DEFAULT_SCOPE),
              resource: String(query.resource ?? `${origin(request)}/mcp`),
            },
          }),
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      })

      .post("/authorize", async ({ body, request }) => {
        const form = (body ?? {}) as Record<string, unknown>;
        const field = (name: string) => String(form[name] ?? "");

        if (!auth.ownerPassphrase?.trim()) {
          return new Response("OAuth is not configured on this deployment.", { status: 501 });
        }

        const clientId = field("client_id");
        const redirectUri = field("redirect_uri");
        const client = await oauth.getClient(store, clientId);
        if (!client || !oauth.isRegisteredRedirect(client, redirectUri)) {
          return new Response("Unknown client or unregistered redirect_uri.", { status: 400 });
        }

        const params = {
          client_id: clientId,
          redirect_uri: redirectUri,
          state: field("state"),
          code_challenge: field("code_challenge"),
          code_challenge_method: field("code_challenge_method"),
          scope: field("scope") || oauth.DEFAULT_SCOPE,
          resource: field("resource"),
        };

        // Throttle BEFORE the comparison. Checking afterwards would still let
        // an attacker learn "wrong" at full speed, which is the only signal
        // they need — and would leak "right" to a locked-out caller.
        const ip = clientIp(request);
        const held = await wait(request, "authorize");
        if (held > 0) {
          return tooManyAttempts(
            held,
            approvalPage({
              clientName: client.clientName ?? client.clientId,
              error: `Too many failed attempts. Try again in ${held}s.`,
              params,
            }),
          );
        }

        if (!(await checkOwner(store, field("passphrase"), auth.ownerPassphrase))) {
          if (throttled) await recordFailure(store, "authorize", ip);
          return new Response(
            approvalPage({
              clientName: client.clientName ?? client.clientId,
              error: "That passphrase does not match. Try again.",
              params,
            }),
            { status: 401, headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        // A correct passphrase clears the record: an owner who mistypes twice
        // and then succeeds must not carry those failures forward.
        if (throttled) await recordSuccess(store, "authorize", ip);

        try {
          const code = await oauth.issueCode(store, {
            clientId,
            redirectUri,
            codeChallenge: params.code_challenge,
            codeChallengeMethod: params.code_challenge_method,
            scope: params.scope,
            resource: params.resource || null,
          });
          const target = new URL(redirectUri);
          target.searchParams.set("code", code);
          // `state` is the client's CSRF defence. Dropping it fails the flow at
          // the client, with an error that points nowhere near this server.
          if (params.state) target.searchParams.set("state", params.state);
          // RFC 9207. Lets a client that talks to several authorization servers
          // prove WHICH one answered, closing the mix-up attack where a code
          // from a malicious AS is redeemed at an honest one. Byte-identical to
          // the `issuer` in the metadata, because the client compares them
          // without normalising.
          target.searchParams.set("iss", origin(request));
          return new Response(null, { status: 302, headers: { location: target.toString() } });
        } catch (error) {
          return new Response(error instanceof Error ? error.message : "Authorization failed.", {
            status: 400,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
      })

      // ── token exchange ─────────────────────────────────────────────────────
      .post("/oauth/token", async ({ body, set }) => {
        const form = (body ?? {}) as Record<string, unknown>;
        const field = (name: string) => String(form[name] ?? "");

        if (field("grant_type") !== "authorization_code") {
          set.status = 400;
          return { error: "unsupported_grant_type" };
        }
        try {
          const result = await oauth.exchangeCode(store, {
            code: field("code"),
            clientId: field("client_id"),
            redirectUri: field("redirect_uri"),
            codeVerifier: field("code_verifier"),
          });
          return {
            access_token: result.accessToken,
            token_type: "Bearer",
            expires_in: result.expiresIn,
            scope: result.scope,
          };
        } catch {
          // One opaque error for every failure mode. Naming which check failed
          // hands an attacker a probing oracle.
          set.status = 400;
          return { error: "invalid_grant" };
        }
      })

      // ── the browser's session ──────────────────────────────────────────────
      .get("/login", ({ query }) => {
        if (!guarded) return new Response(null, { status: 302, headers: { location: "/" } });
        return new Response(
          loginPage({ instanceName, next: query.next ? String(query.next) : undefined }),
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      })

      .post("/login", async ({ body, request }) => {
        const form = (body ?? {}) as Record<string, unknown>;
        const next = String(form.next ?? "/") || "/";

        const ip = clientIp(request);
        const held = await wait(request, "login");
        if (held > 0) {
          return tooManyAttempts(
            held,
            loginPage({ instanceName, error: `Too many failed attempts. Try again in ${held}s.` }),
          );
        }

        if (
          !auth.ownerPassphrase?.trim() ||
          !(await checkOwner(store, String(form.passphrase ?? ""), auth.ownerPassphrase))
        ) {
          if (throttled) await recordFailure(store, "login", ip);
          return new Response(loginPage({ instanceName, error: "That passphrase does not match." }), {
            status: 401,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (throttled) await recordSuccess(store, "login", ip);

        return new Response(null, {
          status: 302,
          headers: {
            // Same-origin paths only. An attacker-supplied `next` of
            // `https://evil/` — or the protocol-relative `//evil/`, which a
            // naive startsWith("/") check accepts — would otherwise turn a
            // successful login into an open redirect.
            location: next.startsWith("/") && !next.startsWith("//") ? next : "/",
            "set-cookie": sessionCookie(
              await issueSession(await sessionKey()),
              isSecureRequest(request),
            ),
          },
        });
      })

      .post("/logout", ({ request }) => {
        return new Response(null, {
          status: 302,
          headers: {
            location: "/",
            "set-cookie": clearedSessionCookie(isSecureRequest(request)),
          },
        });
      })

      /**
       * Change the lock.
       *
       * Requires the CURRENT passphrase even though the caller is already
       * authenticated. A live session is proof someone got in once; it is not
       * proof they are the owner right now, and "change the lock" is exactly the
       * operation a hijacked session would want. Re-asking costs one field.
       */
      .post("/api/passphrase", async ({ body, request, set }) => {
        const form = (body ?? {}) as Record<string, unknown>;
        const current = String(form.current ?? "");
        const next = String(form.next ?? "").trim();

        if (!auth.ownerPassphrase?.trim()) {
          set.status = 501;
          return { error: "not_configured", message: "Set OWNER_PASSPHRASE before changing it." };
        }
        if (!(await checkOwner(store, current, auth.ownerPassphrase))) {
          set.status = 401;
          return { error: "wrong_passphrase", message: "That is not the current passphrase." };
        }
        if (next.length < MIN_PASSPHRASE) {
          set.status = 400;
          return { error: "too_short", message: `Use at least ${MIN_PASSPHRASE} characters.` };
        }

        await setPassphrase(store, next);
        // Re-issue THIS session against the new key, so changing the lock does
        // not sign the person who changed it out of their own browser.
        return new Response(
          JSON.stringify({ ok: true, message: "Passphrase changed. Other sessions were signed out." }),
          {
            headers: {
              "content-type": "application/json",
              "set-cookie": sessionCookie(await issueSession(await sessionKey()), isSecureRequest(request)),
            },
          },
        );
      })

      /** Back to the deployed secret — the recovery path, in one call. */
      .delete("/api/passphrase", async ({ request }) => {
        await clearPassphrase(store);
        return new Response(
          JSON.stringify({ ok: true, message: "Reverted to the deployed OWNER_PASSPHRASE." }),
          {
            headers: {
              "content-type": "application/json",
              "set-cookie": sessionCookie(await issueSession(await sessionKey()), isSecureRequest(request)),
            },
          },
        );
      })

      /** Is a passphrase stored, or are we on the deployed secret? Never the value. */
      .get("/api/passphrase", async () => ({
        stored: Boolean(await readStored(store)),
        min_length: MIN_PASSPHRASE,
      }))

      // ── who holds access ───────────────────────────────────────────────────
      // Behind the gate like any other /api route: this lists the clients that
      // can reach the corpus, which is not public information.
      .get("/api/clients", async () => ({ clients: await oauth.listClients(store) }))

      .delete("/api/clients/:id", async ({ params }) => {
        await oauth.revokeClient(store, params.id);
        return { revoked: params.id };
      })
  );
}
