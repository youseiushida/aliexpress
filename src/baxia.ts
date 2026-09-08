/**
 * Optional recovery path for a flagged client.
 *
 * Once AliExpress has flagged a caller, its detail gateway demands a
 * `_baxia_sec_cookie_` that only its own anti-bot scripts can produce. This
 * module runs those scripts under a DOM and hands back the resulting cookie.
 *
 * It lives behind its own entry point on purpose. JSDOM drags in around thirty
 * transitive packages, while the rest of this library needs none of them, so
 * nothing here loads unless you ask for it:
 *
 * ```ts
 * import { AliExpress } from "@youseiushida/aliexpress";
 * import { mintSessionCookie } from "@youseiushida/aliexpress/baxia";
 *
 * const ae = new AliExpress({ cookieProvider: mintSessionCookie });
 * const detail = await ae.product("1005008812285251"); // recovers by itself
 * ```
 *
 * ## Why a synthetic page
 *
 * The obvious approach — load the real product page and let it run — works but
 * costs about eight seconds, pulls in the entire storefront, and was observed to
 * hang. It is unnecessary. Tracing `document.cookie` writes showed the cookie is
 * assembled locally, with no server round trip, by scripts the page merely
 * happens to include. Serving a blank document at the product URL with just
 * those three scripts produces the same cookie in one to five seconds.
 *
 * The value arrives in stages, one field at a time, so waiting for the cookie to
 * merely exist is a trap: a one-field value appears within a second and the
 * gateway rejects it. All four fields are required — a three-field value
 * (missing `epssw`) was minted and refused. Hence {@link REQUIRED_FIELDS} and
 * the poll below, which waits for completeness rather than existence.
 *
 * ## Minting alone is not enough
 *
 * Of the four fields in the cookie, only `epssw` is validated — swapping each in
 * turn between a working browser cookie and a refused minted one flipped the
 * verdict for that field and no other. It is a device fingerprint, JSDOM has no
 * canvas, and the value comes out at 239-295 characters against a browser's 391.
 * AliExpress refuses it, whichever page the mint loads from.
 *
 * So a flagged machine needs one browser-issued `epssw`, passed as
 * {@link MintOptions.epssw}. It is reusable, so it is asked for once.
 *
 * ## What was ruled out
 *
 * Running only the cookie-writing script under a hand-built zero-dependency
 * shim yields `lwrid` alone and is rejected; `epssw` is triggered by the cosmos
 * bundle, not by that script. happy-dom produced no cookie at all in 31 seconds.
 * No off-the-shelf library for this exists. JSDOM remains the lightest thing
 * measured to work.
 *
 * Treat it as best-effort regardless: it runs third-party scripts under an
 * incomplete DOM, and throws throughout even when it succeeds. Give it a
 * timeout and a fallback rather than assuming it works.
 *
 * Note also that a minted cookie is not reusable — a second detail lookup on
 * the same client is refused again and mints again. Budget a few seconds per
 * lookup while flagged, which is one more reason to pace detail requests well
 * enough never to be flagged in the first place.
 *
 * @module
 */

/** Anything JSDOM needs from us, kept narrow so the import stays lazy. */
interface MintedWindow {
  document: { cookie: string };
  close(): void;
}

/**
 * Scripts the product page loads, in its own order.
 *
 * `LWSC-G` writes the cookie; the cosmos bundle is what sets up the `epssw`
 * field, which the gateway will not accept a cookie without.
 */
const SCRIPTS = [
  "https://assets.aliexpress-media.com/g/ae-fe/global/0.0.3/index.js",
  "https://assets.aliexpress-media.com/g/ae-fe/cosmos/0.0.445/pc/index.js",
  "https://assets.alicdn.com/g/lzd_sec/LWSC-G/index.js",
];

/**
 * Every field the gateway requires.
 *
 * Measured: a three-field value missing `epssw` was minted and refused, so
 * "the cookie exists" is not the completion condition — this list is.
 */
export const REQUIRED_FIELDS = ["lwrid", "tfstk", "lwrtk", "epssw"] as const;

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/152.0.0.0 Safari/537.36";

export interface MintOptions {
  /** Product page URL to present as the document's location. */
  productId?: string;
  /** Site host, e.g. `ja.aliexpress.com`. */
  host?: string;
  userAgent?: string;
  /** Give up after this long. Defaults to 30000. */
  timeoutMs?: number;
  /** How often to check whether the cookie is complete. Defaults to 500. */
  pollIntervalMs?: number;
  /**
   * A browser-issued `epssw` to splice into the minted cookie.
   *
   * `epssw` is the only field AliExpress validates — established by swapping
   * each field between a working browser cookie and a rejected minted one and
   * seeing which flipped the verdict. It is a device fingerprint from a 366 KB
   * obfuscated script, and JSDOM cannot produce an acceptable one: it has no
   * canvas, and its value comes out at 239-295 characters against a browser's
   * 391.
   *
   * Supplying one from a real browser restores detail lookups, and it is
   * reusable — the same value works spliced into freshly minted cookies. Read
   * it out of `document.cookie` on any AliExpress page: the `epssw` key inside
   * the JSON of `_baxia_sec_cookie_`. {@link epsswFrom} does the extraction.
   */
  epssw?: string;
  /**
   * Accept a cookie that is missing some fields. Defaults to false.
   *
   * Only useful for diagnosis: partial values are rejected by the gateway.
   */
  allowPartial?: boolean;
}

/**
 * Pull the `epssw` field out of a `_baxia_sec_cookie_` value or a whole cookie
 * header, so a caller can paste either.
 *
 * @throws {Error} if no `epssw` can be found.
 */
export function epsswFrom(cookieOrValue: string): string {
  const value = cookieOrValue.match(/_baxia_sec_cookie_=([^;]*)/)?.[1] ?? cookieOrValue;
  const decoded = decodeCookieValue(value.trim());
  if (decoded === null) throw new Error("Not a _baxia_sec_cookie_ value: it never decodes to JSON");
  const epssw = (JSON.parse(decoded) as Record<string, unknown>).epssw;
  if (typeof epssw !== "string" || epssw.length === 0) {
    throw new Error("That cookie carries no epssw field");
  }
  return epssw;
}

/** Replace the `epssw` field inside a cookie header, leaving the rest alone. */
export function spliceEpssw(cookie: string, epssw: string): string {
  return cookie.replace(/_baxia_sec_cookie_=([^;]*)/, (whole, value: string) => {
    const decoded = decodeCookieValue(value);
    if (decoded === null) return whole;
    const fields = { ...JSON.parse(decoded) as Record<string, unknown>, epssw };
    return `_baxia_sec_cookie_=${encodeURIComponent(JSON.stringify(fields))}`;
  });
}

/**
 * Peel percent-encoding until the value is the JSON object it describes.
 *
 * JSDOM's cookie store re-encodes on read, so a value the page wrote once
 * encoded comes back encoded twice: `%257B%2522lwrid…` where a browser sends
 * `%7B%22lwrid…`. AliExpress decodes exactly once, so the doubled form arrives
 * as `%7B%22lwrid…` — not JSON — and the request is refused. Left unfixed this
 * is silent: the field names are still findable after one decode, so the cookie
 * looks complete right up until the gateway rejects it.
 *
 * Returns `null` when the value never resolves to a JSON object.
 */
function decodeCookieValue(value: string): string | null {
  let current = value;
  for (let depth = 0; depth < 4; depth++) {
    if (current.startsWith("{")) return current;
    try {
      const next = decodeURIComponent(current);
      if (next === current) return null;
      current = next;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Which of the required fields a cookie header carries.
 *
 * Exported so the completeness rule can be pinned by offline tests: getting it
 * wrong means returning a cookie that only fails later, at the request.
 */
export function fieldsIn(cookie: string): string[] {
  const value = cookie.match(/_baxia_sec_cookie_=([^;]*)/)?.[1];
  if (!value) return [];
  const decoded = decodeCookieValue(value);
  // A value that will not resolve to JSON is broken however many field names it
  // happens to contain, so report nothing rather than a misleading count.
  if (decoded === null) return [];
  return REQUIRED_FIELDS.filter((field) => decoded.includes(field));
}

/**
 * Rewrite the anti-bot cookie into the single-encoded form a browser sends.
 *
 * Everything else in the header is passed through untouched.
 */
export function normalizeCookieHeader(cookie: string): string {
  return cookie.replace(/_baxia_sec_cookie_=([^;]*)/, (whole, value: string) => {
    const decoded = decodeCookieValue(value);
    return decoded === null ? whole : `_baxia_sec_cookie_=${encodeURIComponent(decoded)}`;
  });
}

/**
 * Absorbs failures escaping from the page while a mint is in flight.
 *
 * The scripts we run are somebody else's, and they leave requests outstanding —
 * one seen rejecting with `mtop.ae.cookie.render` long after the DOM was torn
 * down. An unhandled rejection ends the host process, which is an unacceptable
 * way for an optional recovery path to fail, so the whole class is swallowed
 * while we are responsible for that page.
 *
 * Reference counted, because concurrent mints must not disarm each other, and
 * held for a grace period afterwards: the stray rejections arrive *after*
 * teardown, which is exactly when a naive implementation has already stopped
 * listening.
 *
 * Deliberately narrow. An earlier version also absorbed `error`, which swallowed
 * a caller's own uncaught exception and left a script exiting silently with no
 * output at all — far worse than the crash it was guarding against. Only
 * unhandled rejections are caught now, which is the failure mode actually
 * observed from these pages. A caller's own rejection landing inside the window
 * would still be absorbed; that is the residual cost of not crashing.
 */
const SHIELD_GRACE_MS = 5_000;
let shieldDepth = 0;
// `@types/node` rides in with jsdom, so the timer handle is not plainly a number.
let shieldTimer: ReturnType<typeof setTimeout> | undefined;

const absorbFailure = (event: Event) => event.preventDefault();

function raiseShield(): { lower(): void } {
  if (shieldTimer !== undefined) {
    clearTimeout(shieldTimer);
    shieldTimer = undefined;
  }
  if (shieldDepth === 0) {
    globalThis.addEventListener("unhandledrejection", absorbFailure);
  }
  shieldDepth++;

  let lowered = false;
  return {
    lower() {
      if (lowered) return;
      lowered = true;
      shieldDepth--;
      if (shieldDepth > 0) return;
      shieldTimer = setTimeout(() => {
        shieldTimer = undefined;
        if (shieldDepth > 0) return;
        globalThis.removeEventListener("unhandledrejection", absorbFailure);
      }, SHIELD_GRACE_MS);
      // Do not hold the process open just to keep watch.
      if (typeof shieldTimer === "number") Deno.unrefTimer(shieldTimer);
    },
  };
}

/**
 * Run AliExpress' anti-bot scripts and return the cookie header they produce.
 *
 * The returned string is a full `cookie` header and is what
 * {@link import("./types.ts").ClientOptions.cookie} expects.
 *
 * @throws {Error} if no complete cookie appears before the timeout.
 */
export async function mintSessionCookie(options: MintOptions = {}): Promise<string> {
  const host = options.host ?? "ja.aliexpress.com";
  const productId = options.productId ?? "1005008812285251";
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;

  // Imported here rather than at module scope so that merely importing this
  // file — as a type-check or a docs build might — costs nothing.
  const { JSDOM, VirtualConsole } = await import("jsdom");

  // These scripts are written for a real browser and throw freely under JSDOM:
  // no canvas, no matchMedia, no layout geometry. None of it stops the cookie
  // being minted, so the noise is swallowed rather than inflicted on the caller,
  // and `jsdomError` is absorbed so a stray timer cannot crash the host process.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});

  // A blank document served at the product URL. The scripts care about the
  // origin and path they believe they are on, not about the page's content.
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head>${
      SCRIPTS.map((src) => `<script src="${src}" crossorigin></script>`).join("")
    }</head><body></body></html>`,
    {
      url: `https://${host}/item/${productId}.html`,
      referrer: `https://${host}/`,
      userAgent: options.userAgent ?? DEFAULT_UA,
      runScripts: "dangerously",
      resources: "usable",
      pretendToBeVisual: true,
      virtualConsole,
    },
  );
  const win = dom.window as unknown as MintedWindow;

  const shield = raiseShield();

  try {
    const deadline = Date.now() + timeoutMs;
    let best = "";
    let bestFields: string[] = [];

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const cookie = win.document.cookie;
      const fields = fieldsIn(cookie);
      if (fields.length > bestFields.length) {
        best = cookie;
        bestFields = fields;
      }
      if (fields.length === REQUIRED_FIELDS.length) {
        const normalized = normalizeCookieHeader(cookie);
        return options.epssw ? spliceEpssw(normalized, options.epssw) : normalized;
      }
    }

    if (options.allowPartial && best) return normalizeCookieHeader(best);

    const missing = REQUIRED_FIELDS.filter((field) => !bestFields.includes(field));
    throw new Error(
      bestFields.length === 0
        ? `No _baxia_sec_cookie_ appeared within ${timeoutMs}ms. AliExpress may have changed how ` +
          "the cookie is issued, or the scripts failed to load."
        : `Only a partial cookie was minted within ${timeoutMs}ms (missing ${
          missing.join(", ")
        }). ` +
          "The gateway rejects partial values; try a longer timeoutMs.",
    );
  } finally {
    // JSDOM keeps timers and sockets alive; without this the process hangs.
    try {
      win.close();
    } catch { /* already torn down */ }
    shield.lower();
  }
}
