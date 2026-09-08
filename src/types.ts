/**
 * Public data shapes.
 *
 * Stability contract: fields are only ever added within a major version.
 * Anything that AliExpress may omit is typed as nullable rather than optional,
 * so consumers get one consistent shape to branch on.
 *
 * Every normalized object keeps a `raw` escape hatch. AliExpress payloads are
 * large, undocumented and A/B-tested; when normalization misses something, the
 * caller can still dig it out instead of being stuck.
 */

/** Two-letter uppercase country code, e.g. `"JP"`. */
export type CountryCode = string;
/** ISO 4217 code, e.g. `"JPY"`. */
export type CurrencyCode = string;
/** AliExpress locale, e.g. `"ja_JP"`. */
export type Locale = string;

export interface Money {
  /** Numeric amount in major units (e.g. yen, dollars — not cents). */
  value: number;
  currency: CurrencyCode;
  /** Localized string exactly as AliExpress rendered it. */
  formatted: string;
}

export interface Price {
  current: Money;
  /** List price before discount, when one is advertised. */
  original: Money | null;
  /** Percent off, 0-100. */
  discountPct: number | null;
}

export interface StoreRef {
  id: string | null;
  name: string | null;
  url: string | null;
  /** Positive-feedback percentage, 0-100. */
  positiveRate: number | null;
}

/** A single search hit. */
export interface Product {
  id: string;
  title: string;
  url: string;
  /** Primary image, absolute https URL. */
  image: string | null;
  images: string[];
  price: Price | null;
  /** 0-5. */
  rating: number | null;
  /** Units sold, parsed from AliExpress' fuzzy label where possible. */
  orders: number | null;
  store: StoreRef | null;
  /** Marketing labels such as free shipping or Choice badges. */
  badges: string[];
  readonly raw: unknown;
}

/**
 * Delivery terms for the active shipping option.
 *
 * The price on a listing is only half of what a buyer pays, and on cheap
 * hardware the freight is routinely the larger half — so this is part of the
 * answer to "what does it cost", not a detail.
 */
export interface Shipping {
  /** Whether the buyer pays nothing for delivery. */
  free: boolean;
  /** What delivery costs. `null` when {@link free}. */
  cost: Money | null;
  /** Fastest quoted transit in days. */
  daysMin: number | null;
  /** Slowest quoted transit in days. */
  daysMax: number | null;
  /** Localized arrival window as AliExpress renders it, e.g. `"9月 12日"`. */
  etaFrom: string | null;
  etaTo: string | null;
  /** Shipping option's name, e.g. `"AliExpress 標準配送"`. */
  provider: string | null;
  /** Origin country as shown, e.g. `"China"`. */
  shipsFrom: string | null;
  /** Destination the quote was calculated for, e.g. `"Japan"`. */
  shipsTo: string | null;
  /** Whether the option carries tracking. */
  tracked: boolean;
  readonly raw: unknown;
}

export interface SkuVariant {
  id: string;
  /** Property name to selected value, e.g. `{ "Color": "GRAY" }`. */
  attributes: Record<string, string>;
  price: Price | null;
  stock: number | null;
  image: string | null;
  available: boolean;
}

/** Full product page data. */
export interface ProductDetail {
  id: string;
  title: string;
  url: string;
  images: string[];
  price: Price | null;
  rating: number | null;
  /** Number of ratings left. */
  reviews: number | null;
  orders: number | null;
  store: StoreRef | null;
  /** Spec table, e.g. `{ "Application": "xbox" }`. */
  attributes: Record<string, string>;
  skus: SkuVariant[];
  /** Total inventory across SKUs, when exposed. */
  stock: number | null;
  /** Delivery cost and timing for the requested destination. */
  shipping: Shipping | null;
  readonly raw: unknown;
}

export interface FilterOption {
  value: string;
  label: string;
  selected: boolean;
}

/** A refinement axis offered by AliExpress for the current query. */
export interface FilterGroup {
  /** Request parameter this group writes to, e.g. `"selectedSwitches"`. */
  param: string;
  label: string;
  multiple: boolean;
  options: FilterOption[];
}

export interface SortOption {
  value: string;
  label: string;
  selected: boolean;
}

export interface SearchResult {
  query: string;
  page: number;
  pageSize: number;
  /** Total hits reported by AliExpress. Approximate, and capped by the site. */
  total: number | null;
  hasNext: boolean;
  items: Product[];
  /** Refinements available for this query, discovered from the response. */
  filters: FilterGroup[];
  sorts: SortOption[];
  readonly raw: unknown;
}

/**
 * Sort keys accepted by the search endpoint.
 *
 * This is the full set the site offers; its own sort bar lists no others. In
 * particular there is no "newest" sort — AliExpress ignores such a request and
 * returns default ordering, so exposing one would be a silent no-op.
 */
export type SortKey =
  | "default"
  | "orders"
  | "price_asc"
  | "price_desc";

export interface SearchOptions {
  /** 1-based. */
  page?: number;
  sort?: SortKey;
  /** Inclusive lower bound, in the active currency's major units. */
  minPrice?: number;
  /** Inclusive upper bound. */
  maxPrice?: number;
  freeShipping?: boolean;
  /** Only items rated at or above 4 stars. */
  fourStarsUp?: boolean;
  /** Restrict to AliExpress Choice listings. */
  choice?: boolean;
  /** Raw `selectedSwitches` values, for filters this library has no flag for. */
  switches?: string[];
  locale?: Locale;
  currency?: CurrencyCode;
  country?: CountryCode;
  signal?: AbortSignal;
}

export interface SearchAllOptions extends SearchOptions {
  /** Stop after this many items. Defaults to 200. */
  limit?: number;
  /** Never request beyond this page. Defaults to 20. */
  maxPages?: number;
}

export interface ProductOptions {
  locale?: Locale;
  currency?: CurrencyCode;
  country?: CountryCode;
  signal?: AbortSignal;
}

export interface ClientOptions {
  locale?: Locale;
  currency?: CurrencyCode;
  country?: CountryCode;
  /**
   * Site host. Defaults to one derived from `locale`, e.g. `ja.aliexpress.com`.
   */
  host?: string;
  /**
   * Minimum milliseconds between outbound requests. Defaults to 1000.
   *
   * Sustained bursts below roughly a second apart earned an anti-bot challenge
   * during development, so the default is set above that with room to spare.
   */
  minRequestInterval?: number;
  /**
   * Minimum milliseconds between product detail requests. Defaults to 3000.
   *
   * Detail goes through Alibaba's MTOP gateway, which is policed far more
   * tightly than search: it starts answering `RGV587_ERROR` after a modest
   * number of lookups while search from the same address stays perfectly
   * healthy, and the refusal then persists for a long while. Detail therefore
   * gets its own, slower budget on top of {@link minRequestInterval}.
   */
  minDetailRequestInterval?: number;
  /**
   * Replacement for `globalThis.fetch`. Use it to add a proxy, caching, or a
   * retry policy without this library needing to know about any of them.
   */
  fetch?: typeof fetch;
  userAgent?: string;
  /**
   * Cookie header to seed the session with, e.g. copied from a signed-in
   * browser.
   *
   * Only needed to recover product detail after this client has been flagged:
   * the detail gateway then demands a `_baxia_sec_cookie_` that only Alibaba's
   * in-page script can mint. Search never needs it. Values here are merged
   * under anything the site sets during the session.
   */
  cookie?: string;
  /**
   * Called to obtain a fresh cookie header when a detail request is refused.
   *
   * Lets the client recover from being flagged on its own instead of failing.
   * `mintSessionCookie` from the `./baxia` entry point is the ready-made
   * implementation; it is kept out of the core so that callers who do not need
   * it never pay for its dependencies. Invoked at most once per request.
   */
  cookieProvider?: () => Promise<string>;
}
