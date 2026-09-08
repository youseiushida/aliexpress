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
   * Accept a cookie that is missing some fields. Defaults to false.
   *
   * Only useful for diagnosis: partial values are rejected by the gateway.
   */
  allowPartial?: boolean;
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
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    decoded = value;
  }
  return REQUIRED_FIELDS.filter((field) => decoded.includes(field));
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

  // These pages leave promises in flight, and one rejecting after teardown would
  // take the host process down with it — an unacceptable way for an optional
  // recovery path to fail. Rejections are absorbed only for the span of the
  // mint, which is short and runs nothing of the caller's.
  const absorb = (event: Event) => event.preventDefault();
  globalThis.addEventListener("unhandledrejection", absorb);
  globalThis.addEventListener("error", absorb);

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
      if (fields.length === REQUIRED_FIELDS.length) return cookie;
    }

    if (options.allowPartial && best) return best;

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
    // Scripts still in flight can run against the closed document; give them a
    // moment to fail while we are still absorbing.
    await new Promise((resolve) => setTimeout(resolve, 250));
    globalThis.removeEventListener("unhandledrejection", absorb);
    globalThis.removeEventListener("error", absorb);
  }
}
