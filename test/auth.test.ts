/**
 * Authentication, end to end, against in-memory SQLite.
 *
 * The single most important assertion in this file is "the gate reaches routes
 * declared in the PARENT app". An Elysia lifecycle hook registered inside a
 * plugin is local by default: it would guard the plugin's own OAuth endpoints —
 * which need no guarding — and leave /mcp and every /api route wide open, with
 * no error anywhere and every other test in this file still passing. That is
 * the failure this suite exists to make impossible.
 *
 * Everything else here is the OAuth flow's refusals. The happy path is one
 * test; the other fifteen are the ways a client must NOT be able to get in,
 * because in an authorization server the refusals are the product.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createApp } from "../src/app";
import { openSqliteStore } from "../src/store/sqlite";
import type { Store } from "../src/store/types";
import { lockoutSeconds } from "../src/ratelimit";
import { sha256Base64Url } from "../src/utils";

const migrations = ["0001_init.sql", "0002_embeddings.sql", "0003_oauth.sql", "0004_oauth_hashed.sql", "0005_rate_limit.sql", "0006_settings.sql"].map((file) =>
  readFileSync(join(import.meta.dir, "..", "migrations", file), "utf8"),
);

const PASSPHRASE = "open-sesame-please";
const API_TOKEN = "static-token-for-scripts";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let store: Store;

/** A fresh app with whatever credentials the test needs. */
const appWith = (auth: { ownerPassphrase?: string; apiToken?: string; ingressAutoLogin?: boolean }) =>
  createApp({ store, instanceName: "test", auth });

const formTo = (path: string, fields: Record<string, string>) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

const registerClient = async (
  app: ReturnType<typeof createApp>,
  redirectUris: string[] = [REDIRECT],
) => {
  const response = await app.fetch(
    new Request("http://localhost/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: redirectUris }),
    }),
  );
  return { status: response.status, body: (await response.json()) as any };
};

/** Drive the whole dance and hand back a usable access token. */
const fullFlow = async (app: ReturnType<typeof createApp>) => {
  const { body: client } = await registerClient(app);
  const verifier = "a-verifier-long-enough-to-be-real-43-chars-min";
  const challenge = await sha256Base64Url(verifier);

  const approved = await app.fetch(
    formTo("/authorize", {
      passphrase: PASSPHRASE,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      state: "xyz",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "nodes:read nodes:write",
      resource: "http://localhost/mcp",
    }),
  );
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;

  const token = await app.fetch(
    formTo("/oauth/token", {
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }),
  );
  return { client, verifier, challenge, code, token: (await token.json()) as any };
};

beforeEach(async () => {
  store = await openSqliteStore(":memory:", migrations);
});

describe("open by default", () => {
  test("with no secrets set, everything answers exactly as before", async () => {
    const app = appWith({});
    expect((await app.fetch(new Request("http://localhost/api/nodes"))).status).toBe(200);

    const health = (await (await app.fetch(new Request("http://localhost/health"))).json()) as any;
    // Not `false`, not omitted — the word, so an operator reading /health once
    // knows the corpus is public without having to reason about it.
    expect(health.auth).toBe("none");
  });
});

describe("the gate", () => {
  /**
   * THE scope test. If the plugin's onBeforeHandle were locally scoped this
   * would return 200 and every other test here would still pass.
   */
  test("reaches routes declared in the parent app, not just the plugin's own", async () => {
    const app = appWith({ apiToken: API_TOKEN });
    for (const path of ["/api/nodes", "/api/stats", "/api/tools", "/api/vocabularies"]) {
      const response = await app.fetch(new Request(`http://localhost${path}`));
      expect({ path, status: response.status }).toEqual({ path, status: 401 });
    }
  });

  test("guards /mcp, which is the whole point", async () => {
    const app = appWith({ apiToken: API_TOKEN });
    const response = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(response.status).toBe(401);
  });

  test("the 401 points at the resource metadata, which is how a client finds OAuth", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const response = await app.fetch(new Request("http://localhost/api/nodes"));
    const header = response.headers.get("www-authenticate") ?? "";
    expect(header).toContain("Bearer");
    expect(header).toContain(
      'resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"',
    );
    // The scope a client should ask for, in the challenge itself — it should
    // not have to fetch the metadata document to learn what to request.
    expect(header).toContain('scope="nodes:read nodes:write"');
    expect(header).toContain('error="invalid_token"');
    // A browser client that cannot READ the header learns nothing from it.
    expect(response.headers.get("access-control-expose-headers")).toContain("www-authenticate");
  });

  test("leaves discovery, health and the page reachable without a credential", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    for (const path of [
      "/health",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/",
    ]) {
      const response = await app.fetch(new Request(`http://localhost${path}`));
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
    }
  });

  test("serves the lock screen at / rather than a blank 401", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const html = await (await app.fetch(new Request("http://localhost/"))).text();
    expect(html).toContain("Owner passphrase");
    // The corpus UI must not be behind it.
    expect(html).not.toContain("tag cloud");
  });

  test("health names which doors are open, not merely that some are", async () => {
    const both = appWith({ ownerPassphrase: PASSPHRASE, apiToken: API_TOKEN });
    const health = (await (await both.fetch(new Request("http://localhost/health"))).json()) as any;
    expect(health.auth).toEqual(["api-token", "oauth", "owner-session"]);

    const tokenOnly = appWith({ apiToken: API_TOKEN });
    const other = (await (await tokenOnly.fetch(new Request("http://localhost/health"))).json()) as any;
    // Says "oauth" is NOT available — a claude.ai user needs to know this
    // before spending ten minutes on a connector that cannot work.
    expect(other.auth).toEqual(["api-token"]);
  });
});

describe("static bearer", () => {
  test("opens the gate", async () => {
    const app = appWith({ apiToken: API_TOKEN });
    const response = await app.fetch(
      new Request("http://localhost/api/nodes", {
        headers: { authorization: `Bearer ${API_TOKEN}` },
      }),
    );
    expect(response.status).toBe(200);
  });

  test("accepts a lowercase scheme, which RFC 7235 says is legal", async () => {
    const app = appWith({ apiToken: API_TOKEN });
    const response = await app.fetch(
      new Request("http://localhost/api/nodes", {
        headers: { authorization: `bearer ${API_TOKEN}` },
      }),
    );
    expect(response.status).toBe(200);
  });

  test("refuses a wrong token, a prefix of the right one, and a bare token", async () => {
    const app = appWith({ apiToken: API_TOKEN });
    for (const header of [
      "Bearer wrong",
      `Bearer ${API_TOKEN.slice(0, -1)}`,
      API_TOKEN,
      "Basic dXNlcjpwYXNz",
    ]) {
      const response = await app.fetch(
        new Request("http://localhost/api/nodes", { headers: { authorization: header } }),
      );
      expect({ header, status: response.status }).toEqual({ header, status: 401 });
    }
  });
});

describe("discovery documents", () => {
  test("issuer equals the origin the client actually reached", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const body = (await (
      await app.fetch(new Request("http://localhost/.well-known/oauth-authorization-server"))
    ).json()) as any;

    // The trap this project inherited: a mismatch here fails every OAuth client
    // silently while the static-token path keeps working.
    expect(body.issuer).toBe("http://localhost");
    expect(body.authorization_endpoint).toBe("http://localhost/authorize");
    expect(body.token_endpoint).toBe("http://localhost/oauth/token");
    expect(body.registration_endpoint).toBe("http://localhost/oauth/register");
    // S256 only — advertising "plain" invites a client to use it.
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(body.authorization_response_iss_parameter_supported).toBe(true);
  });

  /**
   * A client that 404s on the RFC 8414 path is required to try this one next,
   * and a client that 404s twice stops. Serving the identical body at both URLs
   * is the cheapest insurance against a discovery chain that dead-ends.
   */
  test("the OIDC discovery alias serves the identical document", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const [rfc8414, oidc] = await Promise.all(
      [
        "/.well-known/oauth-authorization-server",
        "/.well-known/openid-configuration",
      ].map(async (path) => (await app.fetch(new Request(`http://localhost${path}`))).json()),
    );
    expect(oidc).toEqual(rfc8414);
  });

  test("the authorization redirect carries iss, so a client can tell which AS answered", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const response = await app.fetch(
      formTo("/authorize", {
        passphrase: PASSPHRASE,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: await sha256Base64Url("some-verifier"),
        code_challenge_method: "S256",
      }),
    );
    const location = new URL(response.headers.get("location")!);
    // Byte-identical to the metadata `issuer` — clients compare without
    // normalising, so a trailing slash here would fail the check.
    expect(location.searchParams.get("iss")).toBe("http://localhost");
  });

  test("the protected resource is the MCP endpoint, not the origin", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const body = (await (
      await app.fetch(new Request("http://localhost/.well-known/oauth-protected-resource/mcp"))
    ).json()) as any;
    expect(body.resource).toBe("http://localhost/mcp");
    expect(body.authorization_servers).toEqual(["http://localhost"]);
  });

  test("PUBLIC_URL overrides the derived origin, exactly and without a trailing slash", async () => {
    const app = createApp({
      store,
      instanceName: "test",
      auth: { ownerPassphrase: PASSPHRASE },
      publicUrl: "https://digger-node.example.com/",
    });
    const body = (await (
      await app.fetch(new Request("http://localhost/.well-known/oauth-authorization-server"))
    ).json()) as any;
    expect(body.issuer).toBe("https://digger-node.example.com");
    expect(body.authorization_endpoint).toBe("https://digger-node.example.com/authorize");
  });
});

describe("dynamic client registration", () => {
  test("registers a client and issues no secret", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { status, body } = await registerClient(app);
    expect(status).toBe(201);
    expect(body.client_id).toBeTruthy();
    expect(body.redirect_uris).toEqual([REDIRECT]);
    expect(body.token_endpoint_auth_method).toBe("none");
    // A public client cannot keep a secret; PKCE is what binds the code to it.
    expect(body.client_secret).toBeUndefined();
  });

  test("requires at least one redirect_uri", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { status, body } = await registerClient(app, []);
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_client_metadata");
  });

  test("refuses plaintext http off loopback, and allows it on", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    expect((await registerClient(app, ["http://evil.example.com/cb"])).status).toBe(400);
    // A local MCP client completing the flow on the user's own machine.
    expect((await registerClient(app, ["http://localhost:7777/callback"])).status).toBe(201);
  });

  test("refuses a redirect_uri with a fragment, which the browser would drop", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    expect((await registerClient(app, ["https://x.example.com/cb#frag"])).status).toBe(400);
  });

  test("says 501, not 404, when OAuth is unconfigured", async () => {
    const app = appWith({ apiToken: API_TOKEN });
    const { status, body } = await registerClient(app);
    // The endpoint exists and is switched off. That is a different problem for
    // whoever is debugging than a wrong URL, and must not read as one.
    expect(status).toBe(501);
    expect(body.error).toBe("oauth_not_configured");
  });
});

describe("the authorization dance", () => {
  test("register, approve, exchange, and the token opens the corpus", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { token } = await fullFlow(app);

    expect(token.token_type).toBe("Bearer");
    expect(token.access_token).toBeTruthy();
    expect(token.expires_in).toBeGreaterThan(0);
    // No refresh token is issued, and none is implied.
    expect(token.refresh_token).toBeUndefined();

    const authed = await app.fetch(
      new Request("http://localhost/api/nodes", {
        headers: { authorization: `Bearer ${token.access_token}` },
      }),
    );
    expect(authed.status).toBe(200);

    // And the same token drives MCP, which is the entire purpose.
    const mcp = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token.access_token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(mcp.status).toBe(200);
    expect(((await mcp.json()) as any).result.tools.length).toBeGreaterThan(10);
  });

  test("echoes state back on the redirect — it is the client's CSRF defence", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const response = await app.fetch(
      formTo("/authorize", {
        passphrase: PASSPHRASE,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        state: "the-clients-nonce",
        code_challenge: await sha256Base64Url("v".repeat(50)),
        code_challenge_method: "S256",
        scope: "nodes:read",
      }),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("the-clients-nonce");
    expect(location.searchParams.get("code")).toBeTruthy();
  });

  test("the consent page renders and carries every parameter forward", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const url =
      `http://localhost/authorize?client_id=${client.client_id}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT)}&state=abc` +
      `&code_challenge=xyz&code_challenge_method=S256&scope=nodes%3Aread`;
    const html = await (await app.fetch(new Request(url))).text();

    expect(html).toContain("Owner passphrase");
    expect(html).toContain('name="state" value="abc"');
    expect(html).toContain('name="code_challenge" value="xyz"');
    // Without these hidden fields the POST cannot issue a code at all.
    expect(html).toContain(`name="client_id" value="${client.client_id}"`);
  });
});

describe("the refusals", () => {
  test("a wrong passphrase issues no code and does not redirect", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const response = await app.fetch(
      formTo("/authorize", {
        passphrase: "not-it",
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: await sha256Base64Url("verifier"),
        code_challenge_method: "S256",
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("does not match");
  });

  /**
   * The open redirect. A client registered for one callback must not be able to
   * receive a code at another, and the failure must land on OUR page — bouncing
   * the browser to the attacker's URL to tell it "no" is the vulnerability.
   */
  test("an unregistered redirect_uri fails on our own page, never as a redirect", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);

    for (const evil of [
      "https://claude.ai.attacker.example/cb",
      `${REDIRECT}.attacker.example`,
      `${REDIRECT}/../elsewhere`,
      "https://claude.ai/api/mcp/auth_callback2",
    ]) {
      const get = await app.fetch(
        new Request(
          `http://localhost/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(evil)}`,
        ),
      );
      expect({ evil, status: get.status, location: get.headers.get("location") }).toEqual({
        evil,
        status: 400,
        location: null,
      });

      const post = await app.fetch(
        formTo("/authorize", {
          passphrase: PASSPHRASE,
          client_id: client.client_id,
          redirect_uri: evil,
          code_challenge: await sha256Base64Url("verifier"),
          code_challenge_method: "S256",
        }),
      );
      expect(post.status).toBe(400);
      expect(post.headers.get("location")).toBeNull();
    }
  });

  test("an unknown client_id is refused", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const response = await app.fetch(
      new Request(
        `http://localhost/authorize?client_id=never-registered&redirect_uri=${encodeURIComponent(REDIRECT)}`,
      ),
    );
    expect(response.status).toBe(400);
  });

  test("code_challenge_method=plain is refused outright", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const response = await app.fetch(
      formTo("/authorize", {
        passphrase: PASSPHRASE,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: "whatever",
        code_challenge_method: "plain",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("S256");
  });

  test("a missing code_challenge is refused — PKCE is not optional here", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const response = await app.fetch(
      formTo("/authorize", {
        passphrase: PASSPHRASE,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: "",
        code_challenge_method: "S256",
      }),
    );
    expect(response.status).toBe(400);
  });

  test("the wrong verifier does not exchange", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const approved = await app.fetch(
      formTo("/authorize", {
        passphrase: PASSPHRASE,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: await sha256Base64Url("the-real-verifier"),
        code_challenge_method: "S256",
      }),
    );
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;

    const response = await app.fetch(
      formTo("/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_verifier: "a-different-verifier",
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as any).error).toBe("invalid_grant");
  });

  /**
   * A failed exchange must BURN the code too. Otherwise an attacker holding an
   * intercepted code gets unlimited attempts at guessing the verifier, which is
   * exactly what PKCE exists to prevent.
   */
  test("a code is single-use, and a failed attempt spends it", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const verifier = "the-real-verifier-value-here";
    const approved = await app.fetch(
      formTo("/authorize", {
        passphrase: PASSPHRASE,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: await sha256Base64Url(verifier),
        code_challenge_method: "S256",
      }),
    );
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;

    const wrong = await app.fetch(
      formTo("/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_verifier: "wrong",
      }),
    );
    expect(wrong.status).toBe(400);

    // The right verifier now fails too — the code was spent by the attempt.
    const retry = await app.fetch(
      formTo("/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }),
    );
    expect(retry.status).toBe(400);
    expect(((await retry.json()) as any).error).toBe("invalid_grant");
  });

  test("a code issued to one client cannot be redeemed by another", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: victim } = await registerClient(app);
    const { body: attacker } = await registerClient(app, ["https://attacker.example/cb"]);
    const verifier = "shared-verifier-value";

    const approved = await app.fetch(
      formTo("/authorize", {
        passphrase: PASSPHRASE,
        client_id: victim.client_id,
        redirect_uri: REDIRECT,
        code_challenge: await sha256Base64Url(verifier),
        code_challenge_method: "S256",
      }),
    );
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;

    const stolen = await app.fetch(
      formTo("/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: attacker.client_id,
        redirect_uri: "https://attacker.example/cb",
        code_verifier: verifier,
      }),
    );
    expect(stolen.status).toBe(400);
  });

  test("an unsupported grant_type is named as such", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const response = await app.fetch(
      formTo("/oauth/token", { grant_type: "client_credentials" }),
    );
    expect(((await response.json()) as any).error).toBe("unsupported_grant_type");
  });

  test("every token failure returns the same opaque error", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const bodies = await Promise.all(
      [
        { grant_type: "authorization_code", code: "nonexistent" },
        { grant_type: "authorization_code", code: "", client_id: "x" },
      ].map(async (fields) =>
        ((await (await app.fetch(formTo("/oauth/token", fields as any))).json()) as any).error,
      ),
    );
    // Telling a caller WHICH check failed hands it a probing oracle.
    expect(new Set(bodies)).toEqual(new Set(["invalid_grant"]));
  });
});

describe("credentials at rest", () => {
  /**
   * The token IS the secret, so a row holding one is as sensitive as the session
   * it opens. Any read of this database — a console session, a backup, an
   * injection in some unrelated query — would otherwise hand over credentials
   * that replay directly against /mcp.
   */
  test("the database stores a digest, never a usable token", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { token } = await fullFlow(app);

    const rows = await store.all<{ token_hash: string }>("SELECT token_hash FROM oauth_tokens");
    expect(rows.length).toBe(1);
    expect(rows[0].token_hash).not.toBe(token.access_token);
    expect(rows[0].token_hash).toBe(await sha256Base64Url(token.access_token));

    // And the plaintext appears nowhere else in the table.
    const dump = JSON.stringify(await store.all("SELECT * FROM oauth_tokens"));
    expect(dump).not.toContain(token.access_token);
  });

  test("an authorization code is stored as a digest too", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const approved = await app.fetch(
      formTo("/authorize", {
        passphrase: PASSPHRASE,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: await sha256Base64Url("verifier"),
        code_challenge_method: "S256",
      }),
    );
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;

    const rows = await store.all<{ code_hash: string }>("SELECT code_hash FROM oauth_codes");
    expect(rows[0].code_hash).toBe(await sha256Base64Url(code));
    expect(rows[0].code_hash).not.toBe(code);
  });

  /**
   * The corollary worth asserting: hashing must not have broken the lookup. A
   * digest stored and a plaintext queried would fail closed — safe, and totally
   * useless — so the happy path is re-checked here from the other direction.
   */
  test("a stolen digest cannot be presented as a token", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { token } = await fullFlow(app);
    const digest = await sha256Base64Url(token.access_token);

    const stolen = await app.fetch(
      new Request("http://localhost/api/nodes", { headers: { authorization: `Bearer ${digest}` } }),
    );
    expect(stolen.status).toBe(401);
  });
});

describe("token audience", () => {
  /**
   * RFC 8707. Fail OPEN on absence and CLOSED on mismatch: not every client
   * sends `resource`, and refusing those would lock out clients behaving
   * legally — but one that told us what the token was for does not get to use
   * it somewhere else.
   */
  test("a token recorded for another resource does not open this one", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const verifier = "verifier-for-the-audience-test";

    const approved = await app.fetch(
      formTo("/authorize", {
        passphrase: PASSPHRASE,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: await sha256Base64Url(verifier),
        code_challenge_method: "S256",
        resource: "https://some-other-server.example/mcp",
      }),
    );
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    const issued = (await (
      await app.fetch(
        formTo("/oauth/token", {
          grant_type: "authorization_code",
          code,
          client_id: client.client_id,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }),
      )
    ).json()) as any;

    // The exchange succeeds — the token is real, just not for here.
    expect(issued.access_token).toBeTruthy();
    const response = await app.fetch(
      new Request("http://localhost/api/nodes", {
        headers: { authorization: `Bearer ${issued.access_token}` },
      }),
    );
    expect(response.status).toBe(401);
  });

  test("a token with no recorded resource is accepted", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { body: client } = await registerClient(app);
    const verifier = "verifier-with-no-resource";

    const approved = await app.fetch(
      formTo("/authorize", {
        passphrase: PASSPHRASE,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: await sha256Base64Url(verifier),
        code_challenge_method: "S256",
        // no `resource` at all — the client never sent one
      }),
    );
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    const issued = (await (
      await app.fetch(
        formTo("/oauth/token", {
          grant_type: "authorization_code",
          code,
          client_id: client.client_id,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }),
      )
    ).json()) as any;

    const response = await app.fetch(
      new Request("http://localhost/api/nodes", {
        headers: { authorization: `Bearer ${issued.access_token}` },
      }),
    );
    expect(response.status).toBe(200);
  });
});

describe("rate limiting the passphrase", () => {
  /**
   * The passphrase is the only credential here a human chose, so it is the only
   * one short enough to guess. Everything else has 32 bytes of entropy behind
   * it. These tests are about the guessing budget, not the comparison.
   */
  const guess = (
    app: ReturnType<typeof createApp>,
    passphrase: string,
    ip = "203.0.113.7",
  ) =>
    app.fetch(
      new Request("http://localhost/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": ip,
        },
        body: new URLSearchParams({ passphrase }).toString(),
      }),
    );

  test("five wrong guesses are allowed, the sixth is throttled", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    for (let i = 1; i <= 5; i++) {
      expect({ attempt: i, status: (await guess(app, "wrong")).status }).toEqual({
        attempt: i,
        status: 401,
      });
    }
    const sixth = await guess(app, "wrong");
    expect(sixth.status).toBe(429);
    // RFC 9110: seconds, and a client that honours it needs it present.
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await sixth.text()).toContain("Too many failed attempts");
  });

  /**
   * The throttle gates the ATTEMPT, not the verdict. Letting a locked-out caller
   * through on a correct guess would tell them the moment they hit it, and the
   * lockout would have protected nothing.
   */
  test("a throttled caller is refused even with the CORRECT passphrase", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    for (let i = 0; i < 5; i++) await guess(app, "wrong");

    const right = await guess(app, PASSPHRASE);
    expect(right.status).toBe(429);
    expect(right.headers.get("set-cookie")).toBeNull();
  });

  test("the budget is per address, and per door", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    for (let i = 0; i < 5; i++) await guess(app, "wrong", "198.51.100.1");
    expect((await guess(app, "wrong", "198.51.100.1")).status).toBe(429);

    // A different address still has its full budget — one attacker must not be
    // able to lock the owner out.
    expect((await guess(app, "wrong", "198.51.100.99")).status).toBe(401);

    // And /authorize is a separate bucket: hammering /login does not close it.
    const { body: client } = await registerClient(app);
    const consent = await app.fetch(
      new Request("http://localhost/authorize", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "198.51.100.1",
        },
        body: new URLSearchParams({
          passphrase: "wrong",
          client_id: client.client_id,
          redirect_uri: REDIRECT,
          code_challenge: await sha256Base64Url("v"),
          code_challenge_method: "S256",
        }).toString(),
      }),
    );
    expect(consent.status).toBe(401);
  });

  test("a correct passphrase clears the record", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const ip = "203.0.113.200";
    for (let i = 0; i < 4; i++) await guess(app, "wrong", ip);
    expect((await guess(app, PASSPHRASE, ip)).status).toBe(302);

    // Four failures then a success must not leave one guess in the tank.
    expect((await store.all("SELECT * FROM auth_attempts")).length).toBe(0);
  });

  test("the backoff doubles and is capped, so waiting always works", async () => {
    expect(lockoutSeconds(4)).toBe(0);
    expect(lockoutSeconds(5)).toBe(120);
    expect(lockoutSeconds(6)).toBe(240);
    expect(lockoutSeconds(7)).toBe(480);
    // Capped — a mistake is recoverable by waiting, never only by redeploying.
    expect(lockoutSeconds(50)).toBe(3600);
  });

  test("it is optional, and /health says which", async () => {
    const off = createApp({ store, instanceName: "test", auth: { ownerPassphrase: PASSPHRASE }, rateLimit: false });
    for (let i = 0; i < 8; i++) {
      expect(
        (
          await off.fetch(
            new Request("http://localhost/login", {
              method: "POST",
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                "cf-connecting-ip": "203.0.113.99",
              },
              body: new URLSearchParams({ passphrase: "wrong" }).toString(),
            }),
          )
        ).status,
      ).toBe(401);
    }
    expect((await store.all("SELECT * FROM auth_attempts")).length).toBe(0);

    const health = async (app: ReturnType<typeof createApp>) =>
      ((await (await app.fetch(new Request("http://localhost/health"))).json()) as any).rate_limit;
    expect(await health(off)).toBe(false);
    expect(await health(appWith({ ownerPassphrase: PASSPHRASE }))).toBe(true);
    // An open server has no passphrase to protect, so there is nothing to say.
    expect(await health(createApp({ store, instanceName: "test" }))).toBeNull();
  });
});

describe("changing the lock", () => {
  const login = (app: ReturnType<typeof createApp>, passphrase: string) =>
    app.fetch(formTo("/login", { passphrase }));
  const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0];

  const change = (app: ReturnType<typeof createApp>, cookie: string, current: string, next: string) =>
    app.fetch(new Request("http://localhost/api/passphrase", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ current, next }),
    }));

  test("a new passphrase works and the old one stops", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const cookie = cookieOf(await login(app, PASSPHRASE));

    const res = await change(app, cookie, PASSPHRASE, "a-memorable-one");
    expect(res.status).toBe(200);

    expect((await login(app, "a-memorable-one")).status).toBe(302);
    expect((await login(app, PASSPHRASE)).status).toBe(302); // env secret still opens it — recovery
  });

  /**
   * The recovery path is deliberate, not an oversight: forgetting what you typed
   * into the UI must not be equivalent to losing the corpus. The deployed secret
   * always works, from a machine you control.
   */
  test("the deployed secret remains a recovery path after a change", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const cookie = cookieOf(await login(app, PASSPHRASE));
    await change(app, cookie, PASSPHRASE, "something-else-entirely");
    expect((await login(app, PASSPHRASE)).status).toBe(302);
  });

  test("the current passphrase is required even with a live session", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const cookie = cookieOf(await login(app, PASSPHRASE));
    // A live session proves someone got in once, not that they are the owner
    // now — and changing the lock is exactly what a hijacked session would want.
    const res = await change(app, cookie, "not-the-current-one", "brand-new-value");
    expect(res.status).toBe(401);
    expect((await login(app, "brand-new-value")).status).toBe(401);
  });

  test("a too-short passphrase is refused with the reason", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const cookie = cookieOf(await login(app, PASSPHRASE));
    const res = await change(app, cookie, PASSPHRASE, "short");
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).message).toContain("at least");
  });

  test("changing the lock signs OTHER sessions out", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const other = cookieOf(await login(app, PASSPHRASE));
    const mine = cookieOf(await login(app, PASSPHRASE));

    expect((await app.fetch(new Request("http://localhost/api/nodes", { headers: { cookie: other } }))).status).toBe(200);

    const res = await change(app, mine, PASSPHRASE, "the-new-lock-value");
    // The session that made the change is re-issued, so you are not locked out
    // of the browser you just used.
    const reissued = cookieOf(res);
    expect(reissued).toContain("digger_session=");
    expect((await app.fetch(new Request("http://localhost/api/nodes", { headers: { cookie: reissued } }))).status).toBe(200);

    // Every other device is out.
    expect((await app.fetch(new Request("http://localhost/api/nodes", { headers: { cookie: other } }))).status).toBe(401);
  });

  test("the stored passphrase is never readable, only its existence", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const cookie = cookieOf(await login(app, PASSPHRASE));
    // The change rotates the session key, so it hands back a re-issued cookie.
    // Carrying the old one forward is exactly the mistake a client would make.
    const fresh = cookieOf(await change(app, cookie, PASSPHRASE, "a-memorable-one"));

    const rows = await store.all<{ value: string }>("SELECT value FROM settings");
    expect(rows[0].value).not.toContain("a-memorable-one");
    // PBKDF2, not a bare digest: a passphrase chosen to be REMEMBERED falls to a
    // wordlist against sha256, which is why this file is not sha256Base64Url.
    expect(rows[0].value).toMatch(/^pbkdf2\$\d+\$/);

    const shown = (await (await app.fetch(new Request("http://localhost/api/passphrase", { headers: { cookie: fresh } }))).json()) as any;
    expect(shown).toEqual({ stored: true, min_length: 8 });
  });

  test("the cookie that made the change is the only one that still works", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const cookie = cookieOf(await login(app, PASSPHRASE));
    const fresh = cookieOf(await change(app, cookie, PASSPHRASE, "a-memorable-one"));

    expect((await app.fetch(new Request("http://localhost/api/passphrase", { headers: { cookie } }))).status).toBe(401);
    expect((await app.fetch(new Request("http://localhost/api/passphrase", { headers: { cookie: fresh } }))).status).toBe(200);
  });

  test("reverting drops back to the deployed secret", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const cookie = cookieOf(await login(app, PASSPHRASE));
    const fresh = cookieOf(await change(app, cookie, PASSPHRASE, "a-memorable-one"));

    // Must use the re-issued cookie — the old one died with the old lock.
    const reverted = await app.fetch(
      new Request("http://localhost/api/passphrase", { method: "DELETE", headers: { cookie: fresh } }),
    );
    expect(reverted.status).toBe(200);
    expect((await login(app, "a-memorable-one")).status).toBe(401);
    expect((await login(app, PASSPHRASE)).status).toBe(302);
  });
});

describe("revocation", () => {
  test("revoking a client kills its live token immediately", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const { client, token } = await fullFlow(app);
    const authorized = { authorization: `Bearer ${token.access_token}` };

    expect((await app.fetch(new Request("http://localhost/api/nodes", { headers: authorized }))).status).toBe(200);

    const listed = (await (
      await app.fetch(new Request("http://localhost/api/clients", { headers: authorized }))
    ).json()) as any;
    expect(listed.clients[0].active_tokens).toBe(1);

    await app.fetch(
      new Request(`http://localhost/api/clients/${client.client_id}`, {
        method: "DELETE",
        headers: authorized,
      }),
    );

    // No cache to wait out: verification reads the table on every request.
    expect((await app.fetch(new Request("http://localhost/api/nodes", { headers: authorized }))).status).toBe(401);
  });

  test("the client list is behind the gate — it names who can reach the corpus", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    expect((await app.fetch(new Request("http://localhost/api/clients"))).status).toBe(401);
  });
});

describe("the browser session", () => {
  const cookieFrom = (response: Response) => (response.headers.get("set-cookie") ?? "").split(";")[0];

  test("a correct passphrase mints a cookie that opens the corpus", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const login = await app.fetch(formTo("/login", { passphrase: PASSPHRASE }));
    expect(login.status).toBe(302);

    const cookie = cookieFrom(login);
    expect(cookie).toContain("digger_session=");
    const raw = login.headers.get("set-cookie")!;
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Lax");
    // Not Secure here: this request arrived over http, and marking it Secure
    // would make the browser silently drop it — a correct passphrase that
    // lands back on the lock screen.
    expect(raw).not.toContain("Secure");

    const response = await app.fetch(new Request("http://localhost/api/nodes", { headers: { cookie } }));
    expect(response.status).toBe(200);
  });

  test("marks the cookie Secure when the request arrived over TLS", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const login = await app.fetch(
      new Request("https://example.com/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ passphrase: PASSPHRASE }).toString(),
      }),
    );
    expect(login.headers.get("set-cookie")).toContain("Secure");
  });

  test("a wrong passphrase mints nothing", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const login = await app.fetch(formTo("/login", { passphrase: "nope" }));
    expect(login.status).toBe(401);
    expect(login.headers.get("set-cookie")).toBeNull();
  });

  test("a forged cookie is refused", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const future = Math.floor(Date.now() / 1000) + 9999;
    for (const forged of [
      `digger_session=${future}.notavalidmac`,
      "digger_session=abc.def",
      "digger_session=",
    ]) {
      const response = await app.fetch(
        new Request("http://localhost/api/nodes", { headers: { cookie: forged } }),
      );
      expect({ forged, status: response.status }).toEqual({ forged, status: 401 });
    }
  });

  test("a cookie signed with a different passphrase does not transfer", async () => {
    const login = await appWith({ ownerPassphrase: PASSPHRASE }).fetch(
      formTo("/login", { passphrase: PASSPHRASE }),
    );
    const cookie = cookieFrom(login);

    // Rotating the passphrase invalidates every outstanding session, for free.
    const rotated = appWith({ ownerPassphrase: "a-different-passphrase" });
    expect(
      (await rotated.fetch(new Request("http://localhost/api/nodes", { headers: { cookie } }))).status,
    ).toBe(401);
  });

  test("`next` cannot be turned into an open redirect", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    for (const [next, expected] of [
      ["//evil.example.com", "/"],
      ["https://evil.example.com", "/"],
      ["/api/stats", "/api/stats"],
    ] as const) {
      const login = await app.fetch(formTo("/login", { passphrase: PASSPHRASE, next }));
      expect({ next, to: login.headers.get("location") }).toEqual({ next, to: expected });
    }
  });

  test("logout clears the cookie", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const response = await app.fetch(formTo("/logout", {}));
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});


/**
 * Ingress auto-login — and the four ways it must refuse.
 *
 * Home Assistant already authenticated whoever is looking at the sidebar panel,
 * so asking for a passphrase one iframe deeper guards a door that is already
 * locked. The risk is the mapped port: digger-node publishes 8108 so MCP
 * clients can reach it, and that port answers anyone on the LAN or the VPN.
 *
 * A sibling add-on on this fleet takes the simple route — a flag that mints a
 * full admin token for anyone who can reach its port — and says so in its own
 * comments. These tests exist because that trade is avoidable here: the header
 * says "rendered inside the iframe", the SOURCE ADDRESS says "and it is really
 * Home Assistant asking", and only both together are enough.
 */
describe("ingress auto-login", () => {
  const PEER = "x-digger-peer-ip";
  const ingressReq = (headers: Record<string, string>) =>
    new Request("http://localhost/api/nodes", { headers });

  test("off by default: a perfect ingress request is still refused", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE });
    const response = await app.fetch(
      ingressReq({ "x-ingress-path": "/api/hassio_ingress/tok", [PEER]: "172.30.32.1" }),
    );
    expect(response.status).toBe(401);
  });

  test("on: an ingress request from the hassio bridge is let in", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, ingressAutoLogin: true });
    const response = await app.fetch(
      ingressReq({ "x-ingress-path": "/api/hassio_ingress/tok", [PEER]: "172.30.32.1" }),
    );
    expect(response.status).toBe(200);
  });

  test("the header alone proves nothing — anyone can send it", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, ingressAutoLogin: true });
    const response = await app.fetch(ingressReq({ "x-ingress-path": "/api/hassio_ingress/tok" }));
    expect(response.status).toBe(401);
  });

  test("THE POINT: the same request from the LAN or the VPN is refused", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, ingressAutoLogin: true });
    for (const peer of ["100.97.192.167", "192.168.1.50", "10.0.0.4", "172.31.32.1", "172.30.34.1"]) {
      const response = await app.fetch(
        ingressReq({ "x-ingress-path": "/api/hassio_ingress/tok", [PEER]: peer }),
      );
      expect({ peer, status: response.status }).toEqual({ peer, status: 401 });
    }
  });

  test("the bridge address alone is not enough either — both halves required", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, ingressAutoLogin: true });
    const response = await app.fetch(ingressReq({ [PEER]: "172.30.32.1" }));
    expect(response.status).toBe(401);
  });

  test("172.30.33.x is inside the /23 and 172.30.31.x is not", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, ingressAutoLogin: true });
    const inside = await app.fetch(
      ingressReq({ "x-ingress-path": "/x", [PEER]: "172.30.33.9" }),
    );
    expect(inside.status).toBe(200);
    const outside = await app.fetch(
      ingressReq({ "x-ingress-path": "/x", [PEER]: "172.30.31.9" }),
    );
    expect(outside.status).toBe(401);
  });

  test("an IPv4-mapped IPv6 peer is still recognised", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, ingressAutoLogin: true });
    const response = await app.fetch(
      ingressReq({ "x-ingress-path": "/x", [PEER]: "::ffff:172.30.32.1" }),
    );
    expect(response.status).toBe(200);
  });

  test("a real credential still wins, so the call log records how they proved it", async () => {
    const app = appWith({ ownerPassphrase: PASSPHRASE, apiToken: API_TOKEN, ingressAutoLogin: true });
    const health = await app.fetch(new Request("http://localhost/health"));
    expect(((await health.json()) as any).auth).toContain("ingress");
  });
});
