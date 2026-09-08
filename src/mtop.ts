import { crypto } from "@std/crypto/crypto";
import { encodeHex } from "@std/encoding/hex";
import { AliBlockedError, AliNotFoundError, AliUpstreamError } from "./errors.ts";
import { asNetworkError, type CookieJar, detectBlock, type Throttle } from "./http.ts";

/**
 * Client for the MTOP gateway, the shared Alibaba API front end that serves the
 * product detail page.
 *
 * Requests are signed with `md5(token & timestamp & appKey & data)`, where the
 * token is the first segment of the `_m_h5_tk` cookie. The cookie is only
 * issued in response to a request, so the first call of a session is expected
 * to fail with a token error and is retried once — that handshake is normal,
 * not an error condition worth surfacing.
 */

/** App key used by the AliExpress desktop web client. */
export const MTOP_APP_KEY = "12574478";

const MTOP_ORIGIN = "https://acs.aliexpress.com";
/** AliExpress really does spell it "EXOIRED". */
const TOKEN_ERRORS = ["TOKEN_EMPTY", "TOKEN_EXOIRED", "TOKEN_EXPIRED"];

export interface MtopContext {
  fetch: typeof fetch;
  jar: CookieJar;
  throttle: Throttle;
  userAgent: string;
  referer: string;
}

interface MtopEnvelope {
  ret?: string[];
  data?: unknown;
}

/** Compute the MTOP request signature. Exported for tests. */
export function mtopSign(
  token: string,
  timestamp: string,
  appKey: string,
  data: string,
): string {
  const input = new TextEncoder().encode(`${token}&${timestamp}&${appKey}&${data}`);
  return encodeHex(crypto.subtle.digestSync("MD5", input));
}

/**
 * Re-label a block as coming from one MTOP API specifically.
 *
 * What the refusal actually means, established by experiment rather than
 * inference:
 *
 * The detail path requires a `_baxia_sec_cookie_` once the caller has been
 * flagged. In the same browser, on the same address, the same request returned
 * `FAIL_SYS_ILLEGAL_ACCESS` with cookies attached — reaching signature
 * validation, so past the edge — and `FAIL_SYS_USER_VALIDATE` with
 * `credentials: "omit"`. Dropping only `_baxia_sec_cookie_` reproduced the
 * refusal, while dropping `cna`, `xman_us_f` or `acs_usuc_t` changed nothing.
 *
 * That cookie cannot be manufactured. It is a ~1 KB opaque blob written by
 * Alibaba's anti-bot script, no HTTP response ever sets it, and substituting a
 * plausible-looking value is rejected. Search needs none of this, which is why
 * it keeps working throughout.
 *
 * Note the flag is what turns the cookie into a requirement: an unflagged
 * client fetches detail happily without one, as this library did until it was
 * exercised too hard. Pacing detail requests is therefore the whole game — see
 * `minDetailRequestInterval`. Once flagged, the options are to wait it out or
 * to supply a real browser session through `ClientOptions.cookie`.
 *
 * Ruled out along the way, so nobody repeats it: the address (a private window
 * on the same connection works), the appKey (five were refused identically,
 * including one that does not exist — which places the refusal ahead of
 * routing), request shape, product-page warm-up, and walking the challenge URL
 * from the refusal, which only serves a JavaScript puzzle.
 */
function asMtopBlock(error: AliBlockedError, api: string): AliBlockedError {
  return new AliBlockedError(
    error.message,
    error.detail,
    `${api} is gated separately from search, and far more tightly — search ` +
      "may well still work. Once flagged it requires a browser-issued " +
      "`_baxia_sec_cookie_`, so either wait the flag out, or pass a real browser " +
      "session via the `cookie` option. Space detail lookups further apart " +
      "(`minDetailRequestInterval`) to avoid being flagged again.",
  );
}

function tokenFromJar(jar: CookieJar): string {
  return (jar.get("_m_h5_tk") ?? "").split("_")[0];
}

function isTokenError(ret: string[] | undefined): boolean {
  const head = ret?.[0] ?? "";
  return TOKEN_ERRORS.some((code) => head.includes(code));
}

async function callOnce(
  ctx: MtopContext,
  api: string,
  version: string,
  data: string,
  signal: AbortSignal | undefined,
): Promise<MtopEnvelope> {
  const timestamp = Date.now().toString();
  const url = new URL(`${MTOP_ORIGIN}/h5/${api}/${version}/`);
  const params: Record<string, string> = {
    jsv: "2.5.1",
    appKey: MTOP_APP_KEY,
    t: timestamp,
    sign: mtopSign(tokenFromJar(ctx.jar), timestamp, MTOP_APP_KEY, data),
    api,
    v: version,
    type: "originaljson",
    dataType: "json",
    data,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await ctx.throttle.run(() =>
    ctx.fetch(url, {
      headers: {
        "user-agent": ctx.userAgent,
        referer: ctx.referer,
        accept: "*/*",
        cookie: ctx.jar.header(),
      },
      signal,
    })
  ).catch((cause) => {
    throw asNetworkError(cause, url.pathname);
  });

  ctx.jar.absorb(response);
  const text = await response.text();

  const blocked = detectBlock(response.status, text);
  if (blocked) throw asMtopBlock(blocked, api);

  try {
    return JSON.parse(text) as MtopEnvelope;
  } catch {
    throw new AliUpstreamError(`MTOP ${api} returned a non-JSON body`, {
      status: response.status,
      preview: text.slice(0, 200),
    });
  }
}

/**
 * Invoke an MTOP API and return its `data` payload.
 *
 * Retries exactly once when the gateway reports a missing or expired token,
 * which refreshes `_m_h5_tk` as a side effect of the failed call.
 */
export async function mtopCall(
  ctx: MtopContext,
  api: string,
  version: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const data = JSON.stringify(payload);

  let envelope = await callOnce(ctx, api, version, data, signal);
  if (isTokenError(envelope.ret)) {
    envelope = await callOnce(ctx, api, version, data, signal);
  }

  const ret = envelope.ret?.[0] ?? "";
  if (!ret.startsWith("SUCCESS")) {
    if (isTokenError(envelope.ret)) {
      throw new AliUpstreamError(`MTOP ${api} could not establish a session token: ${ret}`);
    }
    if (/NOT_FOUND|ITEM_NOT_EXIST|EMPTY/i.test(ret)) {
      throw new AliNotFoundError(`MTOP ${api} reports the item does not exist: ${ret}`);
    }
    if (/FAIL_SYS_USER_VALIDATE|RGV587|FLOW_LIMIT/i.test(ret)) {
      throw asMtopBlock(
        new AliBlockedError(`MTOP ${api} demanded human verification: ${ret}`),
        api,
      );
    }
    throw new AliUpstreamError(`MTOP ${api} failed: ${ret}`, { ret: envelope.ret });
  }

  return envelope.data;
}
