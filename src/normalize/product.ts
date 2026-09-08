import type { Money, Price, ProductDetail, SkuVariant, StoreRef } from "../types.ts";
import { AliSchemaError } from "../errors.ts";
import { absUrl, money, num, parseFuzzyCount, pick, price, productUrl, str } from "./common.ts";

/**
 * Normalizer for the product detail page.
 *
 * The MTOP response is a bag of independently versioned UI modules under
 * `data.result`, keyed by screaming-snake names. Not every module appears for
 * every listing, so each field is read defensively and reported as `null` when
 * its module is absent.
 */

/** Modules read here, so drift reports can name what went missing. */
const MODULES = {
  title: "PRODUCT_TITLE",
  rating: "PC_RATING",
  price: "PRICE",
  images: "HEADER_IMAGE_PC",
  store: "SHOP_CARD_PC",
  props: "PRODUCT_PROP_PC",
  sku: "SKU",
  quantity: "QUANTITY_PC",
} as const;

/**
 * Read a sale price.
 *
 * Unlike search, the detail page exposes the sale amount only as display
 * strings. `salePriceLocal` is pipe-delimited with the bare number in the
 * second field, which is the one machine-readable form available.
 */
function saleMoney(info: unknown, currency: string): Money | null {
  const local = str(pick(info, "salePriceLocal"));
  const formatted = str(pick(info, "salePriceString"));
  const value = local ? num(local.split("|")[1]) : null;
  if (value === null) return null;
  return { value, currency, formatted: formatted ?? `${value} ${currency}` };
}

function priceFrom(info: unknown, fallbackCurrency: string): Price | null {
  const currency = str(pick(info, "originalPrice.currency")) ?? fallbackCurrency;
  return price(saleMoney(info, currency), money(pick(info, "originalPrice"), currency), null);
}

function normalizeStore(result: Record<string, unknown>): StoreRef | null {
  const card = result[MODULES.store];
  if (!card) return null;
  const id = str(pick(card, "sellerInfo.storeNum"));
  const name = str(pick(card, "storeName"));
  if (!id && !name) return null;
  const url = absUrl(pick(card, "sellerInfo.storeURL")) ??
    (str(pick(card, "sellerInfo.storeURL"))?.startsWith("//")
      ? `https:${str(pick(card, "sellerInfo.storeURL"))}`
      : null);
  return { id, name, url, positiveRate: num(pick(card, "sellerPositiveRate")) };
}

function normalizeAttributes(result: Record<string, unknown>): Record<string, string> {
  const props = pick(result[MODULES.props], "showedProps") ??
    pick(result[MODULES.props], "outerProps");
  if (!Array.isArray(props)) return {};
  const attributes: Record<string, string> = {};
  for (const prop of props) {
    const name = str(pick(prop, "attrName"));
    const value = str(pick(prop, "attrValue"));
    if (name && value) attributes[name] = value;
  }
  return attributes;
}

/**
 * Build the variant list.
 *
 * `skuPaths` enumerates the purchasable combinations as `"14:691"` property
 * paths; `skuProperties` holds the human labels those ids resolve to. Joining
 * them gives variants keyed by readable attribute names.
 */
function normalizeSkus(
  result: Record<string, unknown>,
  fallbackCurrency: string,
): SkuVariant[] {
  const sku = result[MODULES.sku];
  const paths = pick(sku, "skuPaths");
  if (!Array.isArray(paths)) return [];

  // propertyId -> { name, values: valueId -> { label, image } }
  const dictionary = new Map<
    string,
    { name: string; values: Map<string, [string, string | null]> }
  >();
  const properties = pick(sku, "skuProperties");
  if (Array.isArray(properties)) {
    for (const property of properties) {
      const id = str(pick(property, "skuPropertyId"));
      if (!id) continue;
      const values = new Map<string, [string, string | null]>();
      const list = pick(property, "skuPropertyValues");
      if (Array.isArray(list)) {
        for (const value of list) {
          const valueId = str(pick(value, "propertyValueIdLong"));
          if (!valueId) continue;
          const label = str(pick(value, "propertyValueDisplayName")) ??
            str(pick(value, "propertyValueDefinitionName")) ??
            str(pick(value, "propertyValueName")) ?? valueId;
          values.set(valueId, [label, absUrl(pick(value, "skuPropertyImagePath"))]);
        }
      }
      dictionary.set(id, { name: str(pick(property, "skuPropertyName")) ?? id, values });
    }
  }

  const priceMap = pick(result[MODULES.price], "skuIdStrPriceInfoMap");
  const quantityMap = pick(result[MODULES.quantity], "allSkuQuantityView");

  return paths.flatMap((path): SkuVariant[] => {
    const id = str(pick(path, "skuIdStr")) ?? str(pick(path, "skuId"));
    if (!id) return [];

    const attributes: Record<string, string> = {};
    let image: string | null = null;
    for (const pair of (str(pick(path, "path")) ?? "").split(",")) {
      const [propertyId, valueId] = pair.split(":");
      const property = dictionary.get(propertyId);
      const value = property?.values.get(valueId);
      if (!property || !value) continue;
      attributes[property.name] = value[0];
      image ??= value[1];
    }

    return [{
      id,
      attributes,
      price: priceFrom(pick(priceMap, id), fallbackCurrency),
      stock: num(pick(path, "skuStock")) ?? num(pick(pick(quantityMap, id), "maxBuyCount")),
      image,
      available: pick(path, "salable") !== false,
    }];
  });
}

function normalizeImages(result: Record<string, unknown>): string[] {
  const module = result[MODULES.images];
  for (const key of ["imgList", "imagePathList", "currentSkuImages"]) {
    const list = pick(module, key);
    if (!Array.isArray(list)) continue;
    const urls = list.map(absUrl).filter((url): url is string => url !== null);
    if (urls.length > 0) return urls;
  }
  return [];
}

/**
 * Normalize an MTOP product detail payload.
 *
 * Throws {@link AliSchemaError} if `data.result` is missing or carries no
 * title, since without those the response cannot be a product page.
 */
export function normalizeProductDetail(
  raw: unknown,
  id: string,
  host: string,
  fallbackCurrency: string,
): ProductDetail {
  const result = pick(raw, "result");
  if (result === null || typeof result !== "object") {
    throw new AliSchemaError("Product response has no `result` object", {
      topLevelKeys: raw && typeof raw === "object" ? Object.keys(raw) : null,
    });
  }
  const modules = result as Record<string, unknown>;

  const title = str(pick(modules[MODULES.title], "text"));
  if (!title) {
    throw new AliSchemaError(`Product response has no ${MODULES.title}.text`, {
      modules: Object.keys(modules),
    });
  }

  const priceModule = modules[MODULES.price];
  const currency = str(pick(priceModule, "targetSkuPriceInfo.originalPrice.currency")) ??
    fallbackCurrency;
  const ratingModule = modules[MODULES.rating];

  return {
    id,
    title,
    url: productUrl(host, id),
    images: normalizeImages(modules),
    price: priceFrom(pick(priceModule, "targetSkuPriceInfo"), currency),
    rating: num(pick(ratingModule, "rating")),
    reviews: num(pick(ratingModule, "totalValidNum")),
    orders: parseFuzzyCount(pick(ratingModule, "otherText")),
    store: normalizeStore(modules),
    attributes: normalizeAttributes(modules),
    skus: normalizeSkus(modules, currency),
    stock: num(pick(modules[MODULES.quantity], "totalAvailableInventory")),
    raw,
  };
}
