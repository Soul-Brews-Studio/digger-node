/**
 * The passphrase you can change, and the reason it is not a plain digest.
 *
 * `OWNER_PASSPHRASE` is a Cloudflare secret: injected per request, read-only to
 * the Worker. Nothing running inside the Worker can rewrite it, so as long as
 * the env var was the only source of truth, "change it from the UI" was not a
 * feature that could exist — rotation meant `wrangler secret put`, a terminal,
 * and the account the thing was deployed from.
 *
 * So the passphrase lives in D1, and the env secret becomes the BOOTSTRAP: it
 * opens a fresh deploy, and it opens the door again if you forget what you set.
 * Both are accepted; the stored one wins when present.
 *
 * ── why PBKDF2 and not sha256 ────────────────────────────────────────────────
 *
 * Elsewhere in this codebase a bare SHA-256 is exactly right: OAuth tokens and
 * authorization codes are 32 random bytes, so a digest of one cannot be reversed
 * by guessing — there is nothing to guess.
 *
 * A passphrase a human chose to REMEMBER is the opposite. `sha256("catlab")`
 * falls to a wordlist instantly, and a stolen database would hand over the
 * passphrase itself rather than a useless hash. The iteration count is the
 * entire defence, and it is why this file exists instead of a call to the
 * existing sha256Base64Url.
 *
 * 210,000 iterations is OWASP's 2023 floor for PBKDF2-HMAC-SHA256. It costs
 * single-digit milliseconds on a Worker and is paid only on login, never on a
 * token check.
 */

import { SETTINGS } from "./sql";
import type { Store } from "./store/types";
import { base64UrlEncode, nowIso, timingSafeEqual } from "./utils";

/**
 * 100,000 — and this number is a RUNTIME CEILING, not a security preference.
 *
 * OWASP's 2023 floor for PBKDF2-HMAC-SHA256 is 210,000, which is what this was
 * set to. bun accepts it, every test passed, and production answered:
 *
 *   Pbkdf2 failed: iteration counts above 100000 are not supported (requested 210000)
 *
 * workerd caps `deriveBits` at 100,000. So the tests could not have caught it —
 * this is the same shape as the `aot: false` bug in app.ts: correct code, green
 * suite, and a failure that exists only on the runtime that actually serves
 * users. The only thing that finds it is running it there.
 *
 * What the lower count costs, stated rather than glossed: half the work per
 * guess for an attacker with the database. The mitigation is that this hash is
 * not the only defence — /login and /authorize are rate limited to five attempts
 * then exponential backoff, so an online attack never reaches the hash's margin,
 * and an offline attack means the database already leaked.
 *
 * The stored format carries its own iteration count, so raising this the day
 * workerd does costs nothing: old hashes keep verifying at the count they were
 * written with.
 */
const ITERATIONS = 100_000;
const KEY = "owner_passphrase";

/** Minimum length. Short enough to remember, long enough that the rate limiter's
 *  five-guess budget is the binding constraint rather than the entropy. */
export const MIN_PASSPHRASE = 8;

function decode(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function derive(passphrase: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    // The cast is the price of one @types/node and the DOM lib disagreeing about
    // what a BufferSource is; workerd accepts the Uint8Array either way.
    { name: "PBKDF2", salt: salt as unknown as ArrayBuffer, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return base64UrlEncode(new Uint8Array(bits));
}

/** `pbkdf2$<iterations>$<salt>$<hash>` — self-describing, so the iteration count
 *  can be raised later without invalidating what is already stored. */
export async function hashPassphrase(passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(passphrase, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${base64UrlEncode(salt)}$${hash}`;
}

export async function verifyAgainstStored(passphrase: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2" || !iterations || !salt || !hash) return false;
  const computed = await derive(passphrase, decode(salt), Number(iterations));
  // Constant-time even though both sides are digests — the habit is the point.
  return timingSafeEqual(computed, hash);
}

export async function readStored(store: Store): Promise<string | null> {
  try {
    const row = await store.first<{ value: string }>(SETTINGS.get, [KEY]);
    return row?.value ?? null;
  } catch {
    // No settings table yet (migration not applied) — fall back to the env
    // secret rather than locking the owner out of their own corpus.
    return null;
  }
}

export async function setPassphrase(store: Store, passphrase: string): Promise<void> {
  if (passphrase.trim().length < MIN_PASSPHRASE) {
    throw new Error(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
  }
  await store.run(SETTINGS.put, [KEY, await hashPassphrase(passphrase.trim()), nowIso()]);
}

/** Back to the env secret. Does not delete the secret — only the override. */
export async function clearPassphrase(store: Store): Promise<void> {
  await store.run(SETTINGS.delete, [KEY]);
}

/**
 * Is this the owner?
 *
 * The stored passphrase wins when one is set; the env secret is always ALSO
 * accepted, and that is deliberate rather than sloppy. It is the recovery path:
 * forget what you typed into the UI and you can still get in with the secret you
 * deployed with, from a machine you control. Removing that would make a
 * forgotten passphrase equivalent to losing the corpus.
 */
export async function checkOwner(
  store: Store,
  presented: string,
  envPassphrase: string | undefined,
): Promise<boolean> {
  if (!presented) return false;

  const stored = await readStored(store);
  if (stored && (await verifyAgainstStored(presented, stored))) return true;

  if (envPassphrase?.trim() && (await timingSafeEqual(presented, envPassphrase.trim()))) return true;

  return false;
}
