import { assert, assertEquals, assertGreater, assertThrows } from "@std/assert";
import { normalizeProduct, normalizeSearch } from "../../src/normalize/search.ts";
import { normalizeProductDetail } from "../../src/normalize/product.ts";
import { parseFuzzyCount, price } from "../../src/normalize/common.ts";
import { AliSchemaError } from "../../src/errors.ts";
import { mtopSign } from "../../src/mtop.ts";
import { assertCoverage, formatCoverage } from "../support/coverage.ts";

/**
 * Offline tests against frozen captures of real responses.
 *
 * These pin the raw-to-normalized mapping and run everywhere, with no network
 * and no flakiness. The live canary in `tests/live/` covers the other half of
 * the problem: whether AliExpress still sends what these fixtures show.
 */

const HOST = "ja.aliexpress.com";

/** Reach into a fixture by dotted path, for asserting on the raw shape. */
function pickPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (
      node,
      key,
    ) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
    source,
  );
}

const searchFixture = JSON.parse(
  await Deno.readTextFile(new URL("../fixtures/search.ja.json", import.meta.url)),
);
const productFixture = JSON.parse(
  await Deno.readTextFile(new URL("../fixtures/product.ja.json", import.meta.url)),
);

Deno.test("normalizeSearch reads page metadata", () => {
  const result = normalizeSearch(searchFixture, "usb capture card", HOST);
  assertEquals(result.query, "usb capture card");
  assertEquals(result.page, 1);
  assertEquals(result.pageSize, 60);
  assertGreater(result.total ?? 0, 0);
});

Deno.test("normalizeSearch maps every item field", () => {
  const result = normalizeSearch(searchFixture, "usb capture card", HOST);
  assertGreater(result.items.length, 0);

  // Identity and imagery are always present. Pricing is not: AliExpress omits
  // the `prices` object entirely on some listings (2 of the 6 captured here),
  // so the threshold is set from what the platform actually sends.
  const report = assertCoverage("search fixture", result.items, {
    id: 1,
    title: 1,
    url: 1,
    image: 1,
    images: 1,
    "price.current.value": 0.6,
    "price.current.currency": 0.6,
    "price.current.formatted": 0.6,
    rating: 0.8,
    orders: 0.8,
  });
  console.log(formatCoverage(report));
});

Deno.test("normalizeSearch derives prices and discounts", () => {
  const { items } = normalizeSearch(searchFixture, "q", HOST);
  const discounted = items.find((item) => item.price?.original);
  assert(discounted, "fixture should contain at least one discounted item");
  const { current, original, discountPct } = discounted.price!;
  assertEquals(current.currency, "JPY");
  assertGreater(original!.value, current.value);
  assertGreater(discountPct ?? 0, 0);
});

Deno.test("normalizeSearch exposes filters and sorts", () => {
  const result = normalizeSearch(searchFixture, "q", HOST);
  assert(result.filters.some((group) => group.param === "selectedSwitches"));
  assert(result.filters.some((group) => group.param === "pr"));
  // The price sort is nested under one entry and must be flattened per direction.
  const sorts = result.sorts.map((sort) => sort.value);
  assert(sorts.includes("price_asc"), `expected price_asc in ${sorts.join(",")}`);
  assert(sorts.includes("price_desc"), `expected price_desc in ${sorts.join(",")}`);
});

Deno.test("normalizeProduct ignores campaign links and builds the canonical URL", () => {
  // Observed live: three of the first four results for one query carried a
  // promo landing page in `productDetailUrl` instead of the product page.
  // Trusting that field hands callers a link to a campaign, not an item.
  const promoted = normalizeProduct({
    productId: "1005006860885924",
    productDetailUrl: "https://www.aliexpress.com/ssr/300000512/jp2024update" +
      "?productIds=1005006860885924:12000038542541787&pha_manifest=ssr&sourceName=SEARCHProduct",
  }, HOST);
  assertEquals(promoted?.url, "https://ja.aliexpress.com/item/1005006860885924.html");

  // And the ordinary case lands on the same shape, so callers see one form.
  const plain = normalizeProduct({
    productId: "1005007319706057",
    productDetailUrl: "https://ja.aliexpress.com/item/1005007319706057.html",
  }, HOST);
  assertEquals(plain?.url, "https://ja.aliexpress.com/item/1005007319706057.html");
});

Deno.test("every fixture item gets a canonical, id-matching URL", () => {
  const { items } = normalizeSearch(searchFixture, "q", HOST);
  for (const item of items) {
    assertEquals(item.url, `https://${HOST}/item/${item.id}.html`);
  }
});

Deno.test("normalizeProduct skips non-product cards", () => {
  assertEquals(normalizeProduct({ itemType: "ad" }, HOST), null);
  assertEquals(normalizeProduct(null, HOST), null);
});

Deno.test("normalizeSearch rejects a payload with no item array", () => {
  assertThrows(
    () => normalizeSearch({ data: { result: {} } }, "q", HOST),
    AliSchemaError,
  );
});

Deno.test("normalizeProductDetail maps the detail modules", () => {
  const detail = normalizeProductDetail(productFixture.data, "1005008812285251", HOST, "JPY");

  assertEquals(detail.id, "1005008812285251");
  assertGreater(detail.title.length, 0);
  assertEquals(detail.url, "https://ja.aliexpress.com/item/1005008812285251.html");

  const report = assertCoverage("product fixture", [detail], {
    title: 1,
    images: 1,
    "price.current.value": 1,
    "price.original.value": 1,
    rating: 1,
    reviews: 1,
    orders: 1,
    "store.id": 1,
    "store.name": 1,
    "store.positiveRate": 1,
    attributes: 1,
    skus: 1,
    stock: 1,
  });
  console.log(formatCoverage(report));
});

Deno.test("normalizeProductDetail reads the delivery quote", () => {
  const { shipping } = normalizeProductDetail(productFixture.data, "1", HOST, "JPY");
  assert(shipping, "the fixture carries a SHIPPING module");
  assertEquals(shipping.daysMin, 4);
  assertEquals(shipping.daysMax, 16);
  assertEquals(shipping.shipsFrom, "China");
  assertEquals(shipping.shipsTo, "Japan");
  assertEquals(shipping.tracked, true);
  assert(shipping.provider);
  assert(shipping.etaFrom);
  assert(shipping.etaTo);
});

Deno.test("shipping is free when the threshold is zero, despite shippingFee=charge", () => {
  // The captured listing says `shippingFee: "charge"` with `displayAmount: 300`,
  // yet AliExpress renders 送料無料 — its own rule is
  // `shippingFee=free||thresholdOverZero!=yes`, and the threshold here is "no".
  // Trusting displayAmount would invent a 300 JPY cost the buyer never pays.
  const data = productFixture.data;
  assertEquals(
    pickPath(data, "result.SHIPPING.deliveryLayoutInfo.0.bizData.shippingFee"),
    "charge",
  );
  assertEquals(pickPath(data, "result.SHIPPING.deliveryLayoutInfo.0.bizData.displayAmount"), 300);

  const { shipping } = normalizeProductDetail(data, "1", HOST, "JPY");
  assertEquals(shipping?.free, true);
  assertEquals(shipping?.cost, null);
});

Deno.test("a charged quote is priced in the display currency, not the settlement one", () => {
  // `currency` is "CNY" even on this JPY listing; only `displayCurrency` matches
  // what the buyer is quoted, so reading the wrong one turns 300 yen into 300 yuan.
  const charged = structuredClone(productFixture.data);
  const bizData = pickPath(
    charged,
    "result.SHIPPING.deliveryLayoutInfo.0.bizData",
  ) as Record<string, unknown>;
  bizData.thresholdOverZero = "yes";

  const { shipping } = normalizeProductDetail(charged, "1", HOST, "JPY");
  assertEquals(shipping?.free, false);
  assertEquals(shipping?.cost?.value, 300);
  assertEquals(shipping?.cost?.currency, "JPY");
  assertEquals(shipping?.cost?.formatted, "300円");
});

Deno.test("a listing with no SHIPPING module yields null rather than throwing", () => {
  const detail = normalizeProductDetail(
    { result: { PRODUCT_TITLE: { text: "x" } } },
    "1",
    HOST,
    "JPY",
  );
  assertEquals(detail.shipping, null);
});

Deno.test("normalizeProductDetail resolves SKU attributes to readable labels", () => {
  const detail = normalizeProductDetail(productFixture.data, "1005008812285251", HOST, "JPY");
  const sku = detail.skus[0];
  assert(sku, "fixture should expose at least one SKU");
  assert(/^\d+$/.test(sku.id));
  // The fixture's SKU path is "14:691", which must resolve through
  // skuProperties into a named attribute rather than staying as raw ids.
  assertGreater(Object.keys(sku.attributes).length, 0);
  for (const [name, value] of Object.entries(sku.attributes)) {
    assert(!/^\d+$/.test(name), `attribute name "${name}" was left as a property id`);
    assertGreater(value.length, 0);
  }
  assertGreater(sku.price?.current.value ?? 0, 0);
  assertEquals(sku.available, true);
});

Deno.test("SKU labels fall back to skuAttr when the property table is missing", () => {
  // Seen live: a four-variant listing returned prices and stock per SKU but no
  // attribute names at all, leaving a caller unable to tell the variants apart.
  const detail = normalizeProductDetail(
    {
      result: {
        PRODUCT_TITLE: { text: "x" },
        SKU: {
          // No `skuProperties`, so the id-to-label join has nothing to resolve.
          skuPaths: [
            { skuIdStr: "111", path: "14:691", skuAttr: "14:691#USB3.0", salable: true },
            { skuIdStr: "222", path: "14:692", skuAttr: "14:692#USB-C", salable: true },
          ],
        },
      },
    },
    "1",
    HOST,
    "JPY",
  );

  assertEquals(detail.skus.map((sku) => sku.attributes), [
    { option: "USB3.0" },
    { option: "USB-C" },
  ]);
});

Deno.test("the property table still wins when it is present", () => {
  // The fallback must not shadow real labels: the fixture resolves through
  // skuProperties and should keep its own naming.
  const detail = normalizeProductDetail(productFixture.data, "1", HOST, "JPY");
  assertEquals(Object.keys(detail.skus[0].attributes), ["カラー"]);
});

Deno.test("normalizeProductDetail rejects a payload with no title module", () => {
  assertThrows(() => normalizeProductDetail({ result: {} }, "1", HOST, "JPY"), AliSchemaError);
  assertThrows(() => normalizeProductDetail({}, "1", HOST, "JPY"), AliSchemaError);
});

Deno.test("parseFuzzyCount reads blurred sales figures", () => {
  assertEquals(parseFuzzyCount("1,000+ sold"), 1000);
  assertEquals(parseFuzzyCount("1,000+ 点販売"), 1000);
  assertEquals(parseFuzzyCount("10K+ sold"), 10_000);
  assertEquals(parseFuzzyCount("49"), 49);
  assertEquals(parseFuzzyCount("no digits"), null);
  assertEquals(parseFuzzyCount(null), null);
});

Deno.test("price hides a fake original and computes the discount", () => {
  const yen = (value: number) => ({ value, currency: "JPY", formatted: `${value}` });
  assertEquals(price(yen(100), yen(100), null)?.original, null);
  assertEquals(price(yen(50), yen(200), null)?.discountPct, 75);
  // An explicitly stated discount wins over the derived one.
  assertEquals(price(yen(50), yen(200), 80)?.discountPct, 80);
  assertEquals(price(null, yen(200), null), null);
});

Deno.test("mtopSign matches the gateway's documented scheme", () => {
  // md5("token&1788877164928&12574478&{}")
  assertEquals(
    mtopSign("token", "1788877164928", "12574478", "{}"),
    "a4fb82551b4e20864d74824dd483505f",
  );
});
