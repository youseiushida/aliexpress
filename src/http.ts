import { AliBlockedError, AliError } from "./errors.ts";

/**
 * A minimal cookie store.
 *
 * AliExpress hands out session cookies on the first page view and expects them
 * back on every subsequent call, including the MTOP gateway on a different
 * host. We only need name/value pairs shared across `*.aliexpress.com`, so this
 * deliberately ignores domain, path and expiry rather than pulling in a full
 * cookie implementation.
 */
export class CookieJar {
  #jar = new Map<string, string>();

  get(name: string): string | undefined {
    return this.#jar.get(name);
  }

  set(name: string, value: string): void {
    this.#jar.set(name, value);
  }

  get size(): number {
    return this.#jar.size;
  }

  /** Absorb every `set-cookie` on a response. */
  absorb(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const match = line.match(/^\s*([^=;]+)=([^;]*)/);
      if (match) this.#jar.set(match[1].trim(), match[2]);
    }
  }

  /** Serialize for a `cookie` request header. */
  header(): string {
    return [...this.#jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

/** Chrome on Windows. AliExpress serves a different payload to unknown agents. */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/152.0.0.0 Safari/537.36";

/**
 * Serializes requests and keeps a floor on the gap between them.
 *
 * AliExpress fronts these endpoints with bot detection; bursts earn a captcha
 * that costs far more time than pacing does.
 */
export class Throttle {
  #intervalMs: number;
  #tail: Promise<void> = Promise.resolve();
  #last = 0;

  constructor(intervalMs: number) {
    this.#intervalMs = intervalMs;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    const scheduled = this.#tail.then(async () => {
      const wait = this.#last + this.#intervalMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.#last = Date.now();
      return await task();
    });
    // Keep the chain alive even when a caller's task rejects.
    this.#tail = scheduled.then(() => {}, () => {});
    return scheduled;
  }
}

/** Signals in a response body that mean "you have been challenged". */
const BLOCK_MARKERS = [
  "punish",
  "captcha",
  "_____tmd_____",
  "nc_iconfont",
  "baxia-dialog",
  "Please verify",
];

/** Heuristic anti-bot detection. */
export function detectBlock(status: number, body: string): AliBlockedError | null {
  if (status === 429) {
    return new AliBlockedError("Rate limited by AliExpress (HTTP 429)", { status });
  }
  if (status === 403) {
    return new AliBlockedError("Request refused by AliExpress (HTTP 403)", { status });
  }
  const head = body.slice(0, 4000);
  const marker = BLOCK_MARKERS.find((m) => head.includes(m));
  if (marker) {
    return new AliBlockedError(`Anti-bot challenge returned by AliExpress (matched ${marker})`, {
      status,
    });
  }
  return null;
}

/** Wrap a transport failure so callers see one error family. */
export function asNetworkError(cause: unknown, url: string): AliError {
  if (cause instanceof AliError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new AliError("NETWORK", `Request to ${url} failed: ${message}`, { cause });
}
