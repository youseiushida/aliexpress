import type {
  FilterGroup,
  FilterOption,
  Product,
  SearchResult,
  SortOption,
  StoreRef,
} from "../types.ts";
import { AliSchemaError } from "../errors.ts";
import { absUrl, money, num, parseFuzzyCount, pick, price, productUrl, str } from "./common.ts";

/** Path to the item array inside a search response. */
const ITEMS_PATH = "data.result.mods.itemList.content";

function normalizeStore(raw: unknown, host: string): StoreRef | null {
  const source = pick(raw, "store");
  if (!source) return null;
  const id = str(pick(source, "storeId")) ?? str(pick(source, "sellerId"));
  const name = str(pick(source, "storeName"));
  if (!id && !name) return null;
  return {
    id,
    name,
    url: id ? `https://${host}/store/${id}` : null,
    positiveRate: num(pick(source, "positiveRate")),
  };
}

/** Marketing labels. Most are image tags, so fall back to the campaign code. */
function normalizeBadges(raw: unknown): string[] {
  const points = pick(raw, "sellingPoints");
  if (!Array.isArray(points)) return [];
  const badges = points
    .map((point) => str(pick(point, "tagContent.displayTagText")) ?? str(pick(point, "source")))
    .filter((badge): badge is string => badge !== null);
  return [...new Set(badges)];
}

/**
 * Normalize one search hit.
 *
 * Returns `null` for entries that carry no product id — the item array also
 * holds ad slots and layout cards, which are not products and should be dropped
 * rather than reported as malformed.
 */
export function normalizeProduct(raw: unknown, host: string): Product | null {
  const id = str(pick(raw, "productId"));
  if (!id) return null;

  const currency = str(pick(raw, "prices.salePrice.currencyCode")) ?? "USD";
  const images = Array.isArray(pick(raw, "images"))
    ? (pick(raw, "images") as unknown[])
      .map((image) => absUrl(pick(image, "imgUrl")))
      .filter((url): url is string => url !== null)
    : [];
  const primary = absUrl(pick(raw, "image.imgUrl")) ?? images[0] ?? null;

  return {
    id,
    title: str(pick(raw, "title.displayTitle")) ?? str(pick(raw, "title.seoTitle")) ?? "",
    // Always synthesized, never AliExpress' own `productDetailUrl`: for
    // promoted listings that field is a campaign landing page
    // (`/ssr/300000512/jp2024update?productIds=...`) rather than the product,
    // which was true of three of the first four results on a live search. The
    // canonical form resolves for every listing and carries no tracking.
    url: productUrl(host, id),
    image: primary,
    images,
    price: price(
      money(pick(raw, "prices.salePrice"), currency),
      money(pick(raw, "prices.originalPrice"), currency),
      num(pick(raw, "prices.salePrice.discount")),
    ),
    rating: num(pick(raw, "evaluation.starRating")),
    orders: num(pick(raw, "trade.realTradeCount")) ??
      parseFuzzyCount(pick(raw, "trade.tradeDesc")),
    store: normalizeStore(raw, host),
    badges: normalizeBadges(raw),
    raw,
  };
}

function normalizeFilters(raw: unknown): FilterGroup[] {
  const groups = pick(raw, "data.result.mods.searchRefineFilters.content");
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group): FilterGroup[] => {
    const param = str(pick(group, "paramName"));
    if (!param) return [];
    const entries = Array.isArray(pick(group, "content"))
      ? pick(group, "content") as unknown[]
      : [];
    const options = entries.flatMap((entry): FilterOption[] => {
      const value = str(pick(entry, "selectedValue"));
      if (!value) return [];
      return [{
        value,
        label: str(pick(entry, "text")) ?? value,
        selected: pick(entry, "selected") === true,
      }];
    });
    return [{
      param,
      label: str(pick(group, "title")) ?? param,
      multiple: pick(group, "isMulti") === true,
      options,
    }];
  });
}

/**
 * Flatten the sort bar. AliExpress nests direction under type, so
 * `price` becomes the two options `price_asc` and `price_desc`.
 */
function normalizeSorts(raw: unknown): SortOption[] {
  const entries = pick(raw, "data.result.mods.sortBar.content");
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry): SortOption[] => {
    const type = str(pick(entry, "sortType"));
    if (!type) return [];
    const orders = Array.isArray(pick(entry, "sortOrders"))
      ? pick(entry, "sortOrders") as unknown[]
      : [];
    if (orders.length <= 1) {
      return [{
        value: type,
        label: str(pick(entry, "sortMultiCopy")) ?? type,
        selected: pick(orders[0], "selected") === true,
      }];
    }
    return orders.flatMap((order): SortOption[] => {
      const direction = str(pick(order, "order"));
      if (!direction) return [];
      return [{
        value: `${type}_${direction}`,
        label: str(pick(order, "sortMultiCopy")) ?? `${type} ${direction}`,
        selected: pick(order, "selected") === true,
      }];
    });
  });
}

/**
 * Normalize a full search response.
 *
 * Throws {@link AliSchemaError} when the item array is missing entirely, which
 * means the payload shape changed. An empty-but-present array is a legitimate
 * "no results" and is passed through.
 */
export function normalizeSearch(raw: unknown, query: string, host: string): SearchResult {
  const items = pick(raw, ITEMS_PATH);
  if (!Array.isArray(items)) {
    throw new AliSchemaError(`Search response has no item array at ${ITEMS_PATH}`, {
      topLevelKeys: raw && typeof raw === "object" ? Object.keys(raw) : null,
    });
  }

  const info = pick(raw, "data.result.pageInfo");
  const page = num(pick(info, "page")) ?? 1;
  const pageSize = num(pick(info, "pageSize")) ?? items.length;
  const total = num(pick(info, "totalResults"));
  const products = items
    .map((item) => normalizeProduct(item, host))
    .filter((item): item is Product => item !== null);

  return {
    query,
    page,
    pageSize,
    total,
    // `finished` is AliExpress' own end-of-results marker; fall back to
    // comparing what we received against the requested page size.
    hasNext: pick(info, "finished") === true ? false : products.length >= pageSize,
    items: products,
    filters: normalizeFilters(raw),
    sorts: normalizeSorts(raw),
    raw,
  };
}
