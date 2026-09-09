# @youseiushida/aliexpress

A lightweight AliExpress client for Deno, usable as a library or a CLI.

It calls the same JSON endpoints the AliExpress website calls. There is no headless browser, no
JSDOM, and no HTML parsing — one small dependency for MD5 and one for argument parsing, and that is
the whole tree.

Built for product research: search with filters and sorting, page through results, and pull full
detail including SKUs, stock, store and specs.

## Install

```sh
deno add jsr:@youseiushida/aliexpress
```

As a CLI:

```sh
deno install -gA -n aliexpress jsr:@youseiushida/aliexpress/cli
```

## Library

```ts
import { AliExpress } from "@youseiushida/aliexpress";

const ae = new AliExpress({ locale: "ja_JP", currency: "JPY", country: "JP" });

const result = await ae.search("usb capture card", { sort: "price_asc" });
console.log(result.total); // approximate total matches
for (const item of result.items) {
  console.log(item.id, item.price?.current.formatted, item.rating, item.title);
}
```

Paging is an async iterator, so the page arithmetic stays out of your code:

```ts
for await (const item of ae.searchAll("usb hub", { limit: 300 })) {
  console.log(item.id, item.title);
}
```

Full detail:

```ts
const detail = await ae.product("1005008812285251");
console.log(detail.attributes); // { "Type": "Video capture card", ... }
console.log(detail.skus); // [{ id, attributes, price, stock, available }]
console.log(detail.stock, detail.store?.positiveRate);
console.log(detail.shipping); // { free, cost, daysMin, daysMax, etaFrom, provider, ... }
```

### Freight is part of the price

On cheap hardware the delivery charge is routinely larger than the difference between two listings,
so `shipping` sits alongside `price` rather than behind a flag:

```ts
const landed = (detail.price?.current.value ?? 0) + (detail.shipping?.cost?.value ?? 0);
```

Two things in this payload mislead if taken at face value, and the library corrects for both:

- **`shippingFee: "charge"` does not mean the buyer is charged.** AliExpress decides its own "free
  shipping" label with `shippingFee=free||thresholdOverZero!=yes`, so a charge against a zero
  threshold still ships free. `shipping.free` follows that rule; reading the raw amount would invent
  a cost the site never shows.
- **`currency` is the settlement currency, not the quoted one** — `"CNY"` on a listing priced in
  yen. `shipping.cost` uses `displayCurrency`, so 300 yen does not become 300 yuan.

Only the free branch has been confirmed against a live listing so far; the charged branch follows
AliExpress' own rule but has not been observed yet.

### Normalized, with an escape hatch

Every result is normalized into stable types, and every object keeps the untouched upstream payload
on `raw`:

```ts
const item = result.items[0];
item.price?.current.value; // 410
item.raw; // the original AliExpress object, whole
```

AliExpress payloads are large, undocumented, and A/B-tested. When normalization misses a field you
need, `raw` means you are inconvenienced rather than blocked.

Fields that AliExpress may omit are typed as nullable rather than optional, so there is one shape to
branch on. Two cases are worth knowing before you plan around them:

- **About a fifth of search results carry no price at all.** That is the platform's behaviour, not a
  parsing failure.
- **Search never carries store information.** `store` is always `null` there; the seller name and
  feedback score only arrive with `product()`.

`url` is always the canonical `https://<host>/item/<id>.html`. AliExpress' own `productDetailUrl` is
not used: on promoted listings it is a campaign landing page rather than the product, which was true
of three of the first four results on one live search.

### Errors

Failures are typed so you can tell them apart:

| Error                | Meaning                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `AliValidationError` | Bad arguments. Thrown before any network call.                              |
| `AliBlockedError`    | Anti-bot challenge or rate limit. Back off; nothing is broken.              |
| `AliSchemaError`     | The response no longer has the fields we read. This library needs updating. |
| `AliNotFoundError`   | No such listing.                                                            |
| `AliUpstreamError`   | AliExpress reported an error of its own.                                    |

### Options

```ts
new AliExpress({
  locale: "ja_JP", // site locale; also picks the host (ja.aliexpress.com)
  currency: "JPY",
  country: "JP", // shipping destination
  minRequestInterval: 1000, // floor between requests, in ms
  fetch: myFetch, // inject a proxy, cache, or retry policy
});
```

Requests are serialized and paced. AliExpress fronts these endpoints with bot detection, and bursts
earn a captcha that costs more time than pacing does.

### Search is cheap; detail is not

The two halves of this library sit behind very different gates, and it is worth planning around.

**Search** tolerates steady use. Paging through several hundred results is routine.

**Product detail** goes through Alibaba's MTOP gateway, which is policed much harder. After a modest
number of lookups it starts answering `RGV587_ERROR` — while search from the same address stays
perfectly healthy — and once that happens the refusal lasts a long time.

What is actually going on, established by experiment rather than guesswork: the MTOP detail call
requires a `_baxia_sec_cookie_` once a caller has been flagged. In one browser, on one connection,
the identical request reached signature validation with cookies attached and was refused at the edge
with `credentials: "omit"`. Dropping only `_baxia_sec_cookie_` reproduced the refusal; dropping
`cna`, `xman_us_f` or `acs_usuc_t` changed nothing. Read that narrowly: it is about
`mtop.aliexpress.pdp.pc.query` seen from a client already under suspicion. The HTML routes behave
differently, and an unflagged browser needs no cookie at all for either (below).

That cookie cannot be forged. It is a ~1 KB opaque blob written by Alibaba's anti-bot script, no
HTTP response ever sets it, and a plausible-looking substitute is rejected.
`mtop.aliexpress.pdp.pc.query` is the only detail _API_ that exists, but it is not necessarily the
only source: an unflagged browser fetching `/item/<id>.html` gets ~75 KB of HTML that does contain
`runParams`, so the page is not as empty as the API-only framing suggests. That route is gated too
(below) and this library does not use it, so treat it as a lead rather than a supported path.

### The gate widens as you probe it

The flag is not a fixed judgement about your client, and this is the part worth internalising before
trying to engineer around it. Over one session of repeated cold requests, the same URL flipped:
`/w/wholesale-esp32.html` served 768 KB, then, with nothing about the client changed, answered the 2
KB baxia punish stub three times running. The gate started on `/item/*.html` and grew to cover the
search page. Nothing client-side was touched between those measurements.

So do not read a refusal as a property of your setup. Measured and eliminated as discriminators, in
a browser refused at the same moment one on the same address was served: cookies (a cookieless
`credentials: "omit"` fetch and one with `_baxia_sec_cookie_` deleted both succeed in an unflagged
browser), the user agent string, request headers and their order, `Sec-Fetch-*` context, HTTP/1.1 vs
h2 vs h3, `navigator.webdriver`, Chrome versus Edge, the HTTP cache, and a real TLS ClientHello
difference — a fresh profile sends extension `0xCA34` and an established one does not, and
suppressing it changes nothing. None of them flip the verdict.

What does correlate is how much cold traffic the caller has just produced. Pacing is therefore the
whole game, and probing the block makes it worse rather than teaching you anything.

Detail gets its own budget (`minDetailRequestInterval`, 3s by default) on top of the shared
throttle, and for product research the shape that works is: search broadly, narrow using the search
fields you already have, and spend detail lookups only on the shortlist.

If you are already flagged and need detail now, there are two ways back.

**Hand it a real browser session:**

```ts
const ae = new AliExpress({ cookie: Deno.env.get("ALIEXPRESS_COOKIE") });
```

The CLI reads the same `ALIEXPRESS_COOKIE` variable. It is taken from the environment rather than a
flag so it stays out of shell history and process listings.

**Or let it mint one for itself**, via the optional `./baxia` entry point:

```ts
import { AliExpress } from "@youseiushida/aliexpress";
import { mintSessionCookie } from "@youseiushida/aliexpress/baxia";

const epssw = Deno.env.get("ALIEXPRESS_EPSSW"); // see below
const ae = new AliExpress({ cookieProvider: () => mintSessionCookie({ epssw }) });
await ae.product("1005008812285251"); // refused, mints, retries, succeeds
```

This runs AliExpress' own anti-bot scripts under JSDOM against a blank document — no storefront, no
browser — in one to five seconds. It is a separate entry point because JSDOM is around thirty
transitive packages the core needs none of.

### The one value the mint cannot produce

A minted cookie has four fields, and **only `epssw` is validated**. That was established by swapping
fields one at a time between a working browser cookie and a refused minted one: swapping `epssw`
flipped the verdict in both directions, while `lwrid`, `tfstk` and `lwrtk` made no difference at
all.

`epssw` is a device fingerprint from a 366 KB obfuscated script. JSDOM has no canvas, and its value
comes out at 239-295 characters against a browser's 391 — short enough that AliExpress refuses it.
Minting alone is therefore **not sufficient** on a flagged machine, whichever page it loads from.

A browser issues a usable one on every page load, so the value need not come from an existing
session — one taken from a freshly opened product page works. Open any AliExpress page and run this
in the DevTools console:

```js
JSON.parse(decodeURIComponent(document.cookie.match(/_baxia_sec_cookie_=([^;]*)/)[1])).epssw;
```

```sh
export ALIEXPRESS_EPSSW='14*0v4N3Mt…'   # or paste the whole cookie value; either is accepted
aliexpress product 1005008812285251 --mint --locale ja_JP --currency JPY --country JP
```

Length is not the test: a 323-character value taken live was accepted where a 295-character JSDOM
one was refused. The content has to be genuine, and only a real browser produces it.

With it, mints are accepted and detail lookups work again; without it the CLI says so on stderr
rather than failing mysteriously. `ALIEXPRESS_COOKIE` remains the alternative: hand over the whole
browser session instead and skip minting.

Two caveats worth knowing: a minted cookie is **not reusable** — each detail lookup pays the mint
again — and the whole thing is best-effort, since it executes third-party scripts under an
incomplete DOM.

## CLI

```sh
aliexpress search "usb capture card" --limit 20 --sort price_asc
aliexpress product 1005008812285251
aliexpress filters "usb cable"   # discover filter codes and sort keys
```

Output is a plain-text table on a terminal and JSON when piped, so both a human and a program get a
usable answer without passing a flag.

### For AI agents

The CLI is designed to be driven by an agent:

- **`aliexpress schema`** prints the whole interface — commands, options, output fields, exit codes
  — as JSON, so an agent can learn it in one call instead of probing `--help` per subcommand.
- **`--fields`** narrows the payload to the dotted paths you actually need. Everything else costs
  tokens for nothing:
  ```sh
  aliexpress search "led strip" --fields id,price.current.value --ndjson
  ```
- **Data goes to stdout, diagnostics to stderr.** Piping never mixes the two. `--quiet` silences the
  progress notes entirely.
- **Exit codes carry meaning**, so a caller knows whether to retry, back off, or give up:

  | Code | Meaning                                                         |
  | ---- | --------------------------------------------------------------- |
  | 0    | success                                                         |
  | 1    | unexpected error                                                |
  | 2    | bad arguments                                                   |
  | 3    | blocked by AliExpress — retry later, the tool is not broken     |
  | 4    | AliExpress changed its response shape — the tool needs updating |

- **Errors are JSON on stderr**: `{"error":{"code","message","hint"}}`.
- **Nothing ever prompts.** There is no interactive path to hang on.
- **Unknown commands fail** rather than guessing. A silent "did you mean" is worse than a refusal
  the agent can read.
- **Output field names are a contract.** They are added, never renamed or removed, within a major
  version.

## Is it still working?

Anything built on a site's own endpoints breaks when that site changes. The tests are split so that
"we broke it" and "they changed it" can never be confused.

```sh
deno task test         # offline, deterministic, against frozen captures
deno task canary       # live: search, paging, sorting, filters, locale, detail
deno task canary:cli   # live: the CLI contract, driven as a subprocess
deno task canary:mint  # live: the ./baxia cookie mint (needs npm)
```

**Offline** tests pin the raw-to-normalized mapping and the cookie-completeness rule against frozen
captures. They need no network and cannot flake.

**Live** suites answer what offline ones cannot. They avoid asserting on values — prices and
listings change hourly — and assert instead on things that should hold regardless:

- **Field coverage.** How often each normalized field comes out populated across a live page of 60
  results. If `price.current.value` is filled for 78% of results today and 0% tomorrow, AliExpress
  changed its payload and the normalizer is silently dropping data. The failure names the field.
- **Parameters still taking effect.** Page 2 differs from page 1; `price_asc` really ascends;
  `orders` really descends; the 4-star and Choice switches are echoed back and change the results; a
  price range is honoured. A parameter that starts being ignored is invisible unless you look.
- **The CLI's own contract.** Exit codes, the error envelope on stderr, `--fields` returning exactly
  the requested keys, `--quiet` leaving stderr silent, an unknown command failing rather than
  guessing, and `schema` staying valid JSON.
- **The mint.** Three consecutive mints each producing a _complete_ cookie, values that differ from
  each other, acceptance by the gateway, and a flagged client recovering through `cookieProvider`.

Blocking is tracked per check. AliExpress rations the detail gateway far harder than search, so one
throttled lookup must not discard the search results a run did establish. A suite reports exit 3
only when nothing at all could be exercised; if some checks passed it exits 0 and names the blocked
ones.

`.github/workflows/canary.yml` runs all three daily. Exit 3 (nothing ran) logs a warning and passes;
exit 4 (drift) opens an issue.

## Scope

Search and product detail. No cart, orders, or authentication.

This library reads the public site's own endpoints, and is subject to whatever rate limits and terms
AliExpress applies. Pace your requests, and expect the official Open Platform API to be the better
answer if you need guarantees.

## License

MIT
