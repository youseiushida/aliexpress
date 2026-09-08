/**
 * A lightweight AliExpress client for Deno.
 *
 * Talks to the same JSON endpoints the AliExpress website calls, so there is no
 * headless browser and no HTML parsing involved. Results are normalized into
 * stable types, and every object keeps the untouched response on `raw` for the
 * cases normalization does not cover.
 *
 * @example Search
 * ```ts
 * import { AliExpress } from "@youseiushida/aliexpress";
 *
 * const ae = new AliExpress({ locale: "ja_JP", currency: "JPY", country: "JP" });
 * const result = await ae.search("usb capture card", { sort: "orders" });
 * for (const item of result.items) {
 *   console.log(item.title, item.price?.current.formatted);
 * }
 * ```
 *
 * @example Paging
 * ```ts
 * for await (const item of ae.searchAll("usb capture card", { limit: 300 })) {
 *   console.log(item.id, item.title);
 * }
 * ```
 *
 * @example Detail
 * ```ts
 * const detail = await ae.product("1005008812285251");
 * console.log(detail.attributes, detail.skus.length);
 * ```
 *
 * @module
 */

export { AliExpress } from "./src/client.ts";

export {
  AliBlockedError,
  AliError,
  type AliErrorCode,
  AliNotFoundError,
  AliSchemaError,
  AliUpstreamError,
  AliValidationError,
  EXIT_CODES,
} from "./src/errors.ts";

export type {
  ClientOptions,
  CountryCode,
  CurrencyCode,
  FilterGroup,
  FilterOption,
  Locale,
  Money,
  Price,
  Product,
  ProductDetail,
  ProductOptions,
  SearchAllOptions,
  SearchOptions,
  SearchResult,
  Shipping,
  SkuVariant,
  SortKey,
  SortOption,
  StoreRef,
} from "./src/types.ts";

export { normalizeProduct, normalizeSearch } from "./src/normalize/search.ts";
export { normalizeProductDetail } from "./src/normalize/product.ts";
