import type {
  ClientOptions,
  Product,
  ProductDetail,
  ProductOptions,
  SearchAllOptions,
  SearchOptions,
  SearchResult,
  SortKey,
} from "./types.ts";
import { AliBlockedError, AliUpstreamError, AliValidationError } from "./errors.ts";
import { asNetworkError, CookieJar, DEFAULT_USER_AGENT, detectBlock, Throttle } from "./http.ts";
import { mtopCall, type MtopContext } from "./mtop.ts";
import { normalizeSearch } from "./normalize/search.ts";
import { normalizeProductDetail } from "./normalize/product.ts";

/**
 * Fallback build id for the search page.
 *
 * The endpoint wants the front end's `pageVersion`. It is scraped from the
 * search HTML at session start; this value only covers the case where the
 * markup changes shape and the scrape misses.
 */
const FALLBACK_PAGE_VERSION = "7ece9c0cc9cf2052db74f0d1b26b7033";

const PDP_API = "mtop.aliexpress.pdp.pc.query";

/** Language subdomains AliExpress serves. Everything else falls back to `www`. */
const LOCALE_HOSTS = new Set([
  "ar",
  "de",
  "es",
  "fr",
  "he",
  "id",
  "it",
  "ja",
  "ko",
  "nl",
  "pl",
  "pt",
  "ru",
  "th",
  "tr",
  "vi",
]);

/**
 * Map our sort keys onto the site's own `sortType` values.
 *
 * Every entry is verified against live responses to actually change the
 * ordering, measured against a control request carrying a deliberately invalid
 * sortType. That control matters: AliExpress re-ranks slightly between any two
 * requests, so "the results moved" is only evidence when compared against what
 * being ignored looks like.
 *
 * `create_desc` was tried for a newest-first sort and landed inside that noise
 * floor, indistinguishable from the invalid control, so no such key is offered.
 */
const SORT_TYPES: Record<SortKey, string | null> = {
  default: null,
  orders: "total_tranpro_desc",
  price_asc: "price_asc",
  price_desc: "price_desc",
};

/** Filter switches AliExpress exposes as named codes. */
const SWITCHES = {
  freeShipping: "filterCode:freeshipping",
  fourStarsUp: "filterCode:4StarRating",
  choice: "filterCode:choice_atm",
} as const;

function hostForLocale(locale: string): string {
  const language = locale.split("_")[0].toLowerCase();
  return LOCALE_HOSTS.has(language) ? `${language}.aliexpress.com` : "www.aliexpress.com";
}

/** Slug AliExpress uses in its `/w/wholesale-*.html` search URLs. */
function querySlug(query: string): string {
  return encodeURIComponent(query.trim().replace(/\s+/g, "-")).slice(0, 200);
}

/**
 * AliExpress client.
 *
 * Reads the same JSON endpoints the desktop site calls, so no browser engine or
 * HTML parser is involved. A session (cookies plus the MTOP token) is
 * established lazily on first use and reused afterwards.
 *
 * @example
 * ```ts
 * const ae = new AliExpress({ locale: "ja_JP", currency: "JPY", country: "JP" });
 * const { items } = await ae.search("usb capture card");
 * const detail = await ae.product(items[0].id);
 * ```
 */
export class AliExpress {
  readonly #locale: string;
  readonly #currency: string;
  readonly #country: string;
  readonly #host: string;
  readonly #fetch: typeof fetch;
  readonly #userAgent: string;
  readonly #cookieProvider: (() => Promise<string>) | undefined;
  readonly #jar = new CookieJar();
  readonly #throttle: Throttle;
  readonly #detailThrottle: Throttle;
  #pageVersion: string | null = null;
  #bootstrapped = false;

  constructor(options: ClientOptions = {}) {
    this.#locale = options.locale ?? "en_US";
    this.#currency = options.currency ?? "USD";
    this.#country = options.country ?? "US";
    this.#host = options.host ?? hostForLocale(this.#locale);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#cookieProvider = options.cookieProvider;
    this.#throttle = new Throttle(options.minRequestInterval ?? 1000);
    this.#detailThrottle = new Throttle(options.minDetailRequestInterval ?? 3000);

    this.#seedCookies(options.cookie);
  }

  /** Merge a `cookie` header string into the jar. */
  #seedCookies(cookie: string | undefined): void {
    for (const pair of (cookie ?? "").split(";")) {
      const index = pair.indexOf("=");
      if (index > 0) this.#jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }

  /** Site host these requests are issued against, e.g. `ja.aliexpress.com`. */
  get host(): string {
    return this.#host;
  }

  /**
   * Fetch the search page once per session to collect cookies and the current
   * `pageVersion`. Later searches post straight to the JSON endpoint.
   */
  async #bootstrap(query: string, signal?: AbortSignal): Promise<void> {
    if (this.#bootstrapped) return;
    this.#bootstrapped = true;

    const url = this.#searchPageUrl(query);
    const response = await this.#throttle.run(() =>
      this.#fetch(url, {
        headers: {
          "user-agent": this.#userAgent,
          "accept-language": this.#acceptLanguage(),
          accept: "text/html,application/xhtml+xml",
        },
        signal,
      })
    ).catch((cause) => {
      throw asNetworkError(cause, url);
    });

    this.#jar.absorb(response);
    const html = await response.text();

    const blocked = detectBlock(response.status, html);
    if (blocked) throw blocked;

    this.#pageVersion = html.match(/pageVersion["'\s:=]+([a-f0-9]{32})/i)?.[1] ??
      FALLBACK_PAGE_VERSION;
    this.#applyLocalePreferences();
  }

  /**
   * Force locale, currency and shipping country into the preference cookie the
   * site reads, so results come back in the requested currency regardless of
   * what the server guessed from our IP.
   */
  #applyLocalePreferences(): void {
    const fields = new Map<string, string>();
    for (const pair of (this.#jar.get("aep_usuc_f") ?? "").split("&")) {
      const [key, value] = pair.split("=");
      if (key) fields.set(key, value ?? "");
    }
    fields.set("region", this.#country);
    fields.set("c_tp", this.#currency);
    fields.set("b_locale", this.#locale);
    this.#jar.set("aep_usuc_f", [...fields].map(([k, v]) => `${k}=${v}`).join("&"));
    this.#jar.set("intl_locale", this.#locale);
  }

  #searchPageUrl(query: string): string {
    return `https://${this.#host}/w/wholesale-${querySlug(query)}.html` +
      `?g=y&SearchText=${encodeURIComponent(query)}`;
  }

  #acceptLanguage(): string {
    return `${this.#locale.split("_")[0]},en;q=0.9`;
  }

  /** Translate typed options into the endpoint's flat `data` parameters. */
  #searchParams(query: string, page: number, options: SearchOptions): Record<string, string> {
    const params: Record<string, string> = {
      g: "y",
      SearchText: query,
      origin: "y",
      page: String(page),
    };

    const sortType = SORT_TYPES[options.sort ?? "default"];
    if (sortType) params.sortType = sortType;

    if (options.minPrice !== undefined || options.maxPrice !== undefined) {
      params.pr = `${options.minPrice ?? ""}-${options.maxPrice ?? ""}`;
    }

    const switches = [
      ...(options.freeShipping ? [SWITCHES.freeShipping] : []),
      ...(options.fourStarsUp ? [SWITCHES.fourStarsUp] : []),
      ...(options.choice ? [SWITCHES.choice] : []),
      ...(options.switches ?? []),
    ];
    if (switches.length > 0) params.selectedSwitches = switches.join(",");

    return params;
  }

  /**
   * Run one page of a search.
   *
   * @param query Free-text search terms.
   * @throws {AliValidationError} when `query` is blank or `page` is below 1.
   * @throws {AliBlockedError} when AliExpress serves an anti-bot challenge.
   * @throws {AliSchemaError} when the response no longer contains an item list.
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      throw new AliValidationError("Search query must not be empty");
    }
    const page = options.page ?? 1;
    if (!Number.isInteger(page) || page < 1) {
      throw new AliValidationError(`Page must be an integer >= 1, got ${options.page}`);
    }

    await this.#bootstrap(trimmed, options.signal);

    const url = `https://${this.#host}/fn/search-pc/index`;
    const response = await this.#throttle.run(() =>
      this.#fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json;charset=UTF-8",
          "user-agent": this.#userAgent,
          "accept-language": this.#acceptLanguage(),
          accept: "*/*",
          origin: `https://${this.#host}`,
          referer: this.#searchPageUrl(trimmed),
          "bx-v": "2.5.37",
          cookie: this.#jar.header(),
        },
        body: JSON.stringify({
          pageVersion: this.#pageVersion,
          target: "root",
          eventName: "onChange",
          dependency: [],
          data: this.#searchParams(trimmed, page, options),
        }),
        signal: options.signal,
      })
    ).catch((cause) => {
      throw asNetworkError(cause, url);
    });

    this.#jar.absorb(response);
    const text = await response.text();

    const blocked = detectBlock(response.status, text);
    if (blocked) throw blocked;
    if (!response.ok) {
      throw new AliUpstreamError(`Search failed with HTTP ${response.status}`, {
        preview: text.slice(0, 200),
      });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new AliUpstreamError("Search returned a non-JSON body", {
        preview: text.slice(0, 200),
      });
    }
    if ((payload as { success?: boolean }).success === false) {
      throw new AliUpstreamError("Search reported success=false", {
        errorMessage: (payload as { errorMessage?: string }).errorMessage,
      });
    }

    return normalizeSearch(payload, trimmed, this.#host);
  }

  /**
   * Walk search results across pages, yielding products as they arrive.
   *
   * Stops at `limit` items, at `maxPages`, or when AliExpress reports the end of
   * the result set, whichever comes first. Duplicate ids are skipped: AliExpress
   * re-ranks between requests and can repeat listings across pages.
   */
  async *searchAll(query: string, options: SearchAllOptions = {}): AsyncGenerator<Product> {
    const limit = options.limit ?? 200;
    const maxPages = options.maxPages ?? 20;
    const firstPage = options.page ?? 1;
    const seen = new Set<string>();
    let yielded = 0;

    for (let page = firstPage; page < firstPage + maxPages; page++) {
      const result = await this.search(query, { ...options, page });
      for (const item of result.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        yield item;
        if (++yielded >= limit) return;
      }
      if (!result.hasNext || result.items.length === 0) return;
    }
  }

  #mtopContext(): MtopContext {
    return {
      fetch: this.#fetch,
      jar: this.#jar,
      throttle: this.#throttle,
      userAgent: this.#userAgent,
      referer: `https://${this.#host}/`,
    };
  }

  /**
   * Fetch full detail for one product.
   *
   * @param id Numeric AliExpress product id, as a string.
   * @throws {AliValidationError} when `id` is not numeric.
   * @throws {AliNotFoundError} when the listing does not exist.
   */
  async product(id: string, options: ProductOptions = {}): Promise<ProductDetail> {
    if (!/^\d+$/.test(id)) {
      throw new AliValidationError(
        `Product id must be numeric, got "${id}"`,
        "Ids look like 1005008812285251 and appear in search results and item URLs.",
      );
    }

    // The detail gateway needs the session cookies the site sets on first view.
    // Always warm up, even when a caller supplied cookies of their own: an
    // injected jar covers the anti-bot token, not the rest of the session.
    await this.#bootstrap(id, options.signal);

    const currency = options.currency ?? this.#currency;
    const request = {
      productId: id,
      _lang: options.locale ?? this.#locale,
      _currency: currency,
      country: options.country ?? this.#country,
      clientType: "pc",
    };

    // Detail is rationed separately from search; see `minDetailRequestInterval`.
    // The inner call still passes through the shared throttle, so this only
    // ever slows detail down, never reorders anything.
    const call = () =>
      this.#detailThrottle.run(() =>
        mtopCall(this.#mtopContext(), PDP_API, "1.0", request, options.signal)
      );

    let payload: unknown;
    try {
      payload = await call();
    } catch (error) {
      // Being refused here means AliExpress wants an anti-bot cookie we cannot
      // produce ourselves. If the caller supplied a way to mint one, this is
      // exactly the moment to use it.
      if (!(error instanceof AliBlockedError) || !this.#cookieProvider) throw error;
      // Merge, do not replace. Clearing the jar first was tried and made things
      // worse: the minted session alone is refused, while folding it into the
      // existing one is what was measured to work.
      this.#seedCookies(await this.#cookieProvider());
      payload = await call();
    }

    return normalizeProductDetail(payload, id, this.#host, currency);
  }

  /**
   * Fetch several products, preserving input order.
   *
   * Requests share the client throttle, so this is a convenience rather than a
   * way to go faster.
   */
  async products(ids: string[], options: ProductOptions = {}): Promise<ProductDetail[]> {
    const results: ProductDetail[] = [];
    for (const id of ids) results.push(await this.product(id, options));
    return results;
  }
}
