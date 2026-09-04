/**
 * A guessing budget for the one credential a human chose.
 *
 * Every other secret in this server has real entropy — a 32-byte bearer token, a
 * PKCE verifier, an authorization code burned on the first failed exchange. The
 * owner passphrase is the exception, and `/login` and `/authorize` were willing
 * to be asked about it without limit. Against a `*.workers.dev` hostname, which
 * is world-reachable the moment it exists, that turns a short passphrase from
 * "weak" into "falls this afternoon".
 *
 * WHAT THIS IS NOT: a perimeter. It keys on the client IP, so an attacker with
 * many addresses gets many budgets and a shared NAT gives many users one. It
 * converts an UNLIMITED online guessing attack into a limited one. A long
 * passphrase is still the real defence; this buys the time to have chosen one.
 *
 * OPTIONAL, and off is a legitimate answer: behind Cloudflare Access, on a
 * private network, or with a 40-character passphrase, the budget buys nothing
 * and costs a D1 write per failed attempt. `createApp({ rateLimit: false })`,
 * or the `RATE_LIMIT=off` var. It defaults ON whenever auth is on, because the
 * deployment that most needs it is the one nobody configured.
 */

import { RATE } from "./sql";
import type { Store } from "./store/types";
import { nowSeconds } from "./utils";

/** Quiet for this long and the record is forgotten — an old typo costs nothing. */
const WINDOW_SECONDS = 15 * 60;

/** Wrong guesses allowed before backoff. Room for a fat-fingered owner, nowhere
 *  near room for a dictionary. */
const FREE_ATTEMPTS = 5;

const MAX_LOCKOUT_SECONDS = 60 * 60;

export type RateBucket = "login" | "authorize";

/**
 * How long to wait after `failures` wrong guesses.
 *
 *   5 → 2m     7 →  8m      9 → 32m
 *   6 → 4m     8 → 16m     10+ → 60m (capped)
 *
 * Five free, then roughly a dozen guesses a day — against the hundreds of
 * thousands per second an unthrottled endpoint allows. The cap means a mistake
 * is always recoverable by waiting rather than by redeploying.
 */
export function lockoutSeconds(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  const doublings = Math.min(failures - FREE_ATTEMPTS + 1, 20);
  return Math.min(2 ** doublings * 60, MAX_LOCKOUT_SECONDS);
}

/**
 * The caller's address as Cloudflare reports it.
 *
 * `CF-Connecting-IP` is set by the edge and cannot be spoofed by the client on a
 * Workers deployment — unlike `X-Forwarded-For`, which is whatever the request
 * claimed and is therefore not trusted here. Off Cloudflare (`bun test`,
 * `wrangler dev`) there is no such header and everything shares one bucket:
 * correct for a single-owner dev box, and what lets the tests exercise this.
 */
export const clientIp = (request: Request): string =>
  request.headers.get("cf-connecting-ip")?.trim() || "local";

/**
 * Seconds the caller must wait, or 0 if they may try now.
 *
 * FAILS OPEN. If the store errors the attempt proceeds, which is the behaviour
 * that existed before this file — bad, but no worse than yesterday. Failing
 * closed would let a transient database fault lock the owner out of their own
 * corpus with no way back in, since the only way to fix it is through the door
 * that just shut. Stated here rather than discovered at 3am.
 */
export async function retryAfter(store: Store, bucket: RateBucket, ip: string): Promise<number> {
  let row: { failures: number; last_at: number } | null = null;
  try {
    row = await store.first(RATE.get, [bucket, ip]);
  } catch {
    return 0;
  }
  if (!row) return 0;

  const elapsed = nowSeconds() - row.last_at;
  if (elapsed > WINDOW_SECONDS) return 0; // stale; the next failure resets it
  return Math.max(0, lockoutSeconds(row.failures) - elapsed);
}

/** Count one wrong passphrase. Best-effort: a store error must not turn a failed
 *  login into a 500, which would be a louder oracle than the 401 itself. */
export async function recordFailure(store: Store, bucket: RateBucket, ip: string): Promise<void> {
  const now = nowSeconds();
  try {
    await store.run(RATE.fail, [bucket, ip, now, now - WINDOW_SECONDS, now]);
  } catch {
    /* fail open — see retryAfter */
  }
}

/** A correct passphrase wipes the slate for that caller. */
export async function recordSuccess(store: Store, bucket: RateBucket, ip: string): Promise<void> {
  try {
    await store.run(RATE.clear, [bucket, ip]);
  } catch {
    /* best effort */
  }
}

/** The 429. `Retry-After` is in seconds, per RFC 9110. */
export const tooManyAttempts = (seconds: number, html: string): Response =>
  new Response(html, {
    status: 429,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "retry-after": String(seconds),
      "access-control-allow-origin": "*",
    },
  });
