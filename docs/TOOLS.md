# Tools

Every tool the server exposes, taken from the registry in `packages/core/src/tools.ts`. The registry
is the single source of truth: the Worker publishes it through MCP `tools/list`, validates
every call against it, and the daemon validates again with the same schemas.

A test (`packages/core/test/docs.test.ts`) fails when this file lacks a level-3 heading made of the
tool name in backticks for a registered tool, or has one for a tool that is not registered. Use that
heading form for tools only.

## Status

The registry describes 35 tools; the daemon implements fewer of them today. This table is the one
place that records which. It is a snapshot of the commit that introduced this document: check
`FLOWS` in `packages/daemon/src/flows/index.ts` for the current set.

| Where it runs      | Tools                                                    | State                                                                                     |
| ------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Worker (hub tools) | `list_browsers`, `select_browser`, `get_audit_log`       | Implemented                                                                               |
| Worker (hub tools) | `get_status`                                             | Implemented, but returns less than its description promises                               |
| Daemon             | `get_cart`, `list_subscriptions`, `get_browsing_history` | Implemented                                                                               |
| Daemon             | every other tool                                         | Planned: the daemon answers `unsupported` ("is not available in this daemon version yet") |

Descriptions below that say "Planned" restate the registry's intent, not behavior you can rely on.
In particular no write tool exists yet, `show_on_screen` is not implemented, and the two-step cart
add (including `needs_choice`) is specified in the registry only. For a planned tool, the error
lists below are labeled "Expected errors": what it is meant to return once built. Today a call to
one fails with `unsupported` from the daemon, or earlier with a routing error from the hub
(`invalid_arguments`, `no_browser_online`, `browser_offline`, `not_found` for an unknown browser
name, `daemon_outdated`, `timeout`).

## Conventions

### Result envelope

Every tool result is one text block holding JSON. On success it is `{ ok: true, browser, data }`;
`browser` is `{ id, name, note? }` for tools that ran on a computer. On failure it is
`{ ok: false, browser?, error }` with the MCP `isError` flag set, where `error` is
`{ code, message, kind?, retry_after_s?, details? }`. The codes are listed under Errors.

Results that came from a computer (everything except the four hub tools) are wrapped: a fixed
notice line saying the block is third-party data and never instructions, then the JSON inside a
tag named `untrusted-external-content-from-amazon-<uuid>` with a fresh random id per call, so page
text cannot close the tag. Daemon error payloads are wrapped too, because they can carry
page-derived text. The hub tools return plain JSON.

Image blocks (media and price charts only) follow the text block as MCP image content, at most 8
per call.

### Browser selection

Every daemon tool takes an optional `browser` argument. The Worker picks the computer in this
order and tells you which one served the call in `browser`:

1. The `browser` argument, matched against id, then name, then alias (case-insensitive; no alias
   can be set yet, see `select_browser`). A name that matches nothing is `not_found`; a match
   that is offline is `browser_offline`. Neither falls back.
2. This connection's selection from `select_browser`. If that computer is offline the call falls
   back to the most recently active online computer and says so in `browser.note`.
3. The most recently active online computer (by last input time reported in presence).

With no computer online the error is `no_browser_online`.

### Size budget and cursors

Tools that take `max_chars` aim to return no more than that many characters of JSON (default
40000, hard cap 120000; values outside 2000 to 120000 are rejected by the schema). Truncation is
never silent: the result carries `truncated: true` and, when more is available, `next_cursor`.
Pass it as `cursor` to continue the same parsed page without loading Amazon again. Lists are cut
from the end. A continuation returns only the paged lists. Cursors live in daemon memory for 15
minutes (at most 40 are kept); an expired one is `not_found` and you repeat the call without it.
If nothing is left to cut, the result is a `partial_json` string with a note to raise `max_chars`.
The Worker refuses any daemon result whose data exceeds the hard cap plus 20000 characters.

### Pacing classes

Each tool names a pacing class. The daemon loads one page at a time per computer, waits a random
1.5 to 4 seconds between loads, and enforces per-class caps (counted per rolling hour and per
rolling day, persisted across restarts). Hitting a cap or a cool-down returns `throttled` with
`retry_after_s`. A captcha, a sign-in prompt or any other human-only page starts a 30 minute
cool-down for the whole computer (10 minutes when Amazon itself throttles). At most 4 calls may be
running or waiting on one computer; the fifth fails with `busy`.

| Class           | Per hour | Per day | Used by                                                                                                       |
| --------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `search`        | 60       | 400     | `search`                                                                                                      |
| `product`       | 90       | 600     | `get_product`, `get_variants`, `get_media`, `get_review_summary`                                              |
| `offers`        | 60       | 400     | `get_buying_options`                                                                                          |
| `reviews`       | 40       | 250     | `get_reviews`                                                                                                 |
| `account`       | 60       | 300     | `list_orders`, `get_order`, `get_invoice`, `list_subscriptions`, `get_browsing_history`, `get_search_history` |
| `cart`          | 90       | 500     | `get_cart` and the cart write tools                                                                           |
| `list`          | 60       | 300     | `list_lists`, `get_list` and the list write tools                                                             |
| `price_history` | 12       | 60      | `get_price_history`                                                                                           |

`show_on_screen` has class `none`: it does not count against any budget. The hub tools have no
class. The config file accepts a `pacing` override object, but no code reads it yet, so the
defaults above are the only limits.

### Two-step cart adds

Adding to the cart is deliberately a two-step flow (planned: no write flow is implemented yet).
Step one is `get_buying_options`, which returns offers with short-lived opaque `offer_id` values
and per-offer flags. Step two is `add_to_cart` with exactly one `offer_id`; ASIN-only adds do not
exist. If the chosen offer carries any flag, the add returns `needs_choice` with the flags and
alternatives and adds nothing, unless every flag on the offer is listed in `acknowledge`.
`out_of_stock` can never be acknowledged. The purchase type defaults to `one_time`.

The flags that `acknowledge` accepts, from the registry (the meanings are inferred from the
names):

- `used_or_renewed`
- `no_featured_offer`
- `price_above_typical`
- `not_prime`
- `shipping_fee`
- `slow_delivery`
- `minimum_quantity`
- `quantity_limit`
- `multipack_ambiguity`
- `quantity_above_stock`
- `subscribe_and_save_default`
- `preorder_or_backorder`
- `addon_or_bundle_upsell`
- `protection_plan_prompt`
- `third_party_seller`
- `merchant_fulfilled`

### Errors

The full taxonomy, from `packages/core/src/errors.ts`. `needs_human` carries a `kind`: `captcha`,
`sign_in`, `soft_challenge` or `interstitial`.

| Code                  | Meaning                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `needs_human`         | Amazon showed a page only the owner can handle. Do it by hand, then retry after the cool-down    |
| `throttled`           | A pacing cap or cool-down applies; wait `retry_after_s`                                          |
| `no_browser_online`   | No paired computer is connected                                                                  |
| `browser_offline`     | The named computer is offline, dropped mid-call, or its extension cannot be reached              |
| `busy`                | That computer already has 4 calls running or waiting; retry in about 15 seconds                  |
| `not_found`           | Unknown browser name, a page Amazon says does not exist, or an expired cursor                    |
| `layout_unrecognized` | The page was not understood, or Amazon returned an error page                                    |
| `blocked_by_policy`   | The URL policy refused a navigation, fragment or redirect                                        |
| `needs_choice`        | Reserved for `add_to_cart` flags (planned, never produced yet)                                   |
| `daemon_outdated`     | The computer's daemon is older than the hub requires and is updating; retry in about 60 seconds  |
| `hub_outdated`        | Defined, and used as a WebSocket close reason when a daemon speaks a newer protocol than the hub |
| `invalid_arguments`   | The arguments do not match the tool schema, or the tool name is unknown                          |
| `unsupported`         | This daemon version does not implement the tool, or the page is not available                    |
| `timeout`             | The 225 second call deadline or the 45 second page load limit passed                             |
| `internal`            | Anything else; the message never carries the underlying error text                               |

## Browsers

### `list_browsers`

> List the owner's computers that can drive Amazon: stable id, name, aliases, OS, online, last
> active, idle/locked, Chrome running, Amazon signed in, daemon version, and whether it is this
> connection's selection.

Kind: answered by the Worker; read only; pacing: none.

This tool takes no arguments.

**Result.** `{ browsers: [...] }`. Each row: `id`, `name`, `aliases`, `os`, `online`, `last_seen`,
`last_active`, `idle_s`, `locked`, `chrome_running`, `profile_connected`, `amazon_signed_in`,
`cooling_down_until`, `daemon_version`, `selected`. Presence fields are null when the computer is
offline or has not reported yet. Revoked devices are not listed.

**Errors.** `invalid_arguments`.

**Notes.** Answered by the Worker itself; no computer is contacted. `selected` is true for the row
chosen by `select_browser` on this connection.

### `select_browser`

> Set the default browser for THIS connection only (never globally). Pass null to clear the
> selection.

Kind: answered by the Worker; changes state; pacing: none.

| Argument  | Type                          | Required | Notes                                            |
| --------- | ----------------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars) or null | yes      | Browser id, name or alias; see Browser selection |

**Result.** `{ selected: <browser row> }`, or `{ selected: null }` when cleared.

**Errors.** `not_found` (details list the known browser names), `invalid_arguments`.

**Notes.** The selection belongs to this OAuth grant (the connected client), never to the whole
server, and survives token refreshes. Passing `null` clears it. The call is recorded in the audit
log together with its arguments. Matching is exact and case-insensitive against id, then name,
then alias. Aliases are not usable yet: `setup --alias` writes them to the computer's config only,
the hub never receives them, and a device's name is whatever it sent when it paired.

### `show_on_screen`

> Open an amazon.com product, cart, list or order page in a NORMAL (non-automation) tab on the
> chosen computer and bring it to the front, so the owner can finish something (for example
> checkout) by hand. This is the only way to reach checkout: placing orders is not possible
> through this server.

Kind: runs on a computer; changes state; pacing: none.

| Argument  | Type                  | Required | Notes                                            |
| --------- | --------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars) | no       | Browser id, name or alias; see Browser selection |
| `target`  | object                | yes      | Which page to open; see below                    |

**Result.** Planned. The registry promises that the page opens in a normal tab and comes to the
front.

**Expected errors.** Planned: `blocked_by_policy`, `browser_offline`, `invalid_arguments`.

**Notes.** Intended to be the only way to reach checkout: it opens a normal, non-automation tab
for the owner to finish by hand, so it is a hand-off, not a purchase. No code implements it yet.
`target` is one of: `{type: product, asin}`, `{type: cart}`, `{type: list, list_id}`,
`{type: order, order_id}`, `{type: orders}`. Registered as a write tool, so the Worker records its
arguments in the audit log.

## Catalog reads

### `search`

> Search amazon.com. Every result is labeled organic or sponsored (kind + is_sponsored). Returns
> results, widgets (carousels/shelves with their own sponsored flag), all available refinements
> grouped (each with an opaque token usable in `refinements`), sort options, applied filters,
> corrections and pagination.

Kind: runs on a computer; read only; pacing: search.

| Argument      | Type                                                                                                  | Required | Notes                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------- |
| `browser`     | string (max 64 chars)                                                                                 | no       | Browser id, name or alias; see Browser selection                                |
| `query`       | string (min 1, max 300 chars)                                                                         | yes      |                                                                                 |
| `department`  | string (max 64 chars)                                                                                 | no       | Search alias such as 'aps', 'electronics', 'grocery'                            |
| `sort`        | `featured`, `price_low_to_high`, `price_high_to_low`, `avg_customer_review`, `newest`, `best_sellers` | no       |                                                                                 |
| `page`        | integer 1..50                                                                                         | no       |                                                                                 |
| `min_price`   | number >= 0                                                                                           | no       | Dollars                                                                         |
| `max_price`   | number >= 0                                                                                           | no       | Dollars                                                                         |
| `prime_only`  | boolean                                                                                               | no       |                                                                                 |
| `min_rating`  | integer 1..4                                                                                          | no       | Minimum average stars                                                           |
| `brand`       | string (max 100 chars)                                                                                | no       |                                                                                 |
| `condition`   | `new`, `used`, `renewed`                                                                              | no       |                                                                                 |
| `refinements` | array of string (max 30)                                                                              | no       | Opaque refinement tokens from a previous search response (any left-rail filter) |
| `max_chars`   | integer 2000..120000                                                                                  | no       | Size budget in characters (default 40000, cap 120000)                           |

**Result.** Planned. Per the registry: results labeled organic or sponsored (`kind`,
`is_sponsored`), widgets with their own sponsored flag, all refinements grouped with opaque
tokens, sort options, applied filters, corrections and pagination.

**Expected errors.** `needs_human`, `throttled`, `blocked_by_policy`, `layout_unrecognized`,
`timeout`.

**Notes.** `refinements` takes the opaque tokens a previous search response returned.

### `get_product`

> Read a product page: identity, buy-box state, featured offer, variant summary, media counts,
> rating histogram, AI review summary, bullets, description, A+ text, spec tables, notices, and
> other_sections (every visible block no typed parser consumed, so nothing is lost).

Kind: runs on a computer; read only; pacing: product.

| Argument    | Type                   | Required | Notes                                                 |
| ----------- | ---------------------- | -------- | ----------------------------------------------------- |
| `browser`   | string (max 64 chars)  | no       | Browser id, name or alias; see Browser selection      |
| `asin`      | string                 | yes      | 10 characters, A-Z and 0-9                            |
| `max_chars` | integer 2000..120000   | no       | Size budget in characters (default 40000, cap 120000) |
| `cursor`    | string (max 512 chars) | no       | `next_cursor` from a previous response                |

**Result.** Planned. Per the registry: identity, buy-box state, featured offer, variant summary,
media counts, rating histogram, AI review summary, bullets, description, A+ text, spec tables,
notices, and `other_sections` (every visible block no typed parser consumed).

**Expected errors.** `needs_human`, `throttled`, `not_found`, `layout_unrecognized`, `timeout`.

**Notes.** Long pages are cut at the size budget and continue with `cursor`.

### `get_variants`

> Variant dimensions and values, the combination -> child ASIN map, and per-variant price /
> availability / delivery where the page exposes them. fetch_missing loads child pages (within the
> pacing budget) for variants whose offer is not on the page.

Kind: runs on a computer; read only; pacing: product.

| Argument        | Type                   | Required | Notes                                                 |
| --------------- | ---------------------- | -------- | ----------------------------------------------------- |
| `browser`       | string (max 64 chars)  | no       | Browser id, name or alias; see Browser selection      |
| `asin`          | string                 | yes      | 10 characters, A-Z and 0-9                            |
| `fetch_missing` | integer 0..10          | no       | How many child pages to load (default 0)              |
| `max_chars`     | integer 2000..120000   | no       | Size budget in characters (default 40000, cap 120000) |
| `cursor`        | string (max 512 chars) | no       | `next_cursor` from a previous response                |

**Result.** Planned. Per the registry: variant dimensions and values, the combination to child
ASIN map, per-variant price, availability and delivery where the page exposes them.

**Expected errors.** `needs_human`, `throttled`, `not_found`, `layout_unrecognized`, `timeout`.

**Notes.** `fetch_missing` loads child product pages, each counted against the `product` pacing
budget.

### `get_buying_options`

> The featured offer (if any) plus ALL offers (new, used, renewed). Each offer has a short-lived
> opaque offer_id (required by add_to_cart), price, shipping, total, condition, seller,
> ships-from, fulfillment, Prime, delivery promise, quantity limits and flags. Also purchase types
> (one-time, Subscribe & Save) and clippable coupons.

Kind: runs on a computer; read only; pacing: offers.

| Argument    | Type                            | Required | Notes                                                 |
| ----------- | ------------------------------- | -------- | ----------------------------------------------------- |
| `browser`   | string (max 64 chars)           | no       | Browser id, name or alias; see Browser selection      |
| `asin`      | string                          | yes      | 10 characters, A-Z and 0-9                            |
| `condition` | `all`, `new`, `used`, `renewed` | no       |                                                       |
| `max_chars` | integer 2000..120000            | no       | Size budget in characters (default 40000, cap 120000) |

**Result.** Planned. Per the registry: the featured offer plus all offers (new, used, renewed).
Each offer carries a short-lived opaque `offer_id`, price, shipping, total, condition, seller,
ships-from, fulfillment, Prime, delivery promise, quantity limits and flags; also purchase types
and clippable coupons.

**Expected errors.** `needs_human`, `throttled`, `not_found`, `layout_unrecognized`, `timeout`.

**Notes.** Step one of a cart add. The `offer_id` it returns is the only input `add_to_cart`
accepts. The URL policy allowlists one all-offers fragment URL, which this tool is expected to
use.

### `get_media`

> Hi-res image URLs per variant and videos (title, duration, URL, thumbnail).

Kind: runs on a computer; read only; pacing: product.

| Argument      | Type                  | Required | Notes                                               |
| ------------- | --------------------- | -------- | --------------------------------------------------- |
| `browser`     | string (max 64 chars) | no       | Browser id, name or alias; see Browser selection    |
| `asin`        | string                | yes      | 10 characters, A-Z and 0-9                          |
| `with_images` | boolean               | no       | Also return downscaled image blocks (default false) |
| `max_images`  | integer 1..8          | no       |                                                     |

**Result.** Planned. Per the registry: hi-res image URLs per variant and videos (title, duration,
URL, thumbnail).

**Expected errors.** `needs_human`, `throttled`, `not_found`, `layout_unrecognized`, `timeout`.

**Notes.** With `with_images` the result also carries up to 8 downscaled image blocks (the wire
format allows at most 8 per result).

### `get_reviews`

> Paged full review text with sort and filters. Each review: rating, title, body, date, verified,
> variant attributes, helpful votes, media, badges.

Kind: runs on a computer; read only; pacing: reviews.

| Argument            | Type                                                   | Required | Notes                                                 |
| ------------------- | ------------------------------------------------------ | -------- | ----------------------------------------------------- |
| `browser`           | string (max 64 chars)                                  | no       | Browser id, name or alias; see Browser selection      |
| `asin`              | string                                                 | yes      | 10 characters, A-Z and 0-9                            |
| `sort`              | `top`, `recent`                                        | no       |                                                       |
| `stars`             | `1`, `2`, `3`, `4`, `5`, `all`, `positive`, `critical` | no       |                                                       |
| `verified_only`     | boolean                                                | no       |                                                       |
| `keyword`           | string (max 100 chars)                                 | no       |                                                       |
| `this_variant_only` | boolean                                                | no       |                                                       |
| `media_only`        | boolean                                                | no       |                                                       |
| `page`              | integer 1..500                                         | no       |                                                       |
| `max_chars`         | integer 2000..120000                                   | no       | Size budget in characters (default 40000, cap 120000) |

**Result.** Planned. Per the registry: paged review text; each review has rating, title, body,
date, verified, variant attributes, helpful votes, media and badges.

**Expected errors.** `needs_human`, `throttled`, `not_found`, `layout_unrecognized`, `timeout`.

**Notes.** Paged with `page` (1 to 500). Reviews have their own pacing class (40 per hour).

### `get_review_summary`

> Rating, count, histogram, the AI 'Customers say' text and aspect chips, top positive and
> critical review.

Kind: runs on a computer; read only; pacing: product.

| Argument  | Type                  | Required | Notes                                            |
| --------- | --------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars) | no       | Browser id, name or alias; see Browser selection |
| `asin`    | string                | yes      | 10 characters, A-Z and 0-9                       |

**Result.** Planned. Per the registry: rating, count, histogram, the AI summary text and aspect
chips, the top positive and the top critical review.

**Expected errors.** `needs_human`, `throttled`, `not_found`, `layout_unrecognized`, `timeout`.

**Notes.** Uses the `product` pacing class, not `reviews`.

### `get_price_history`

> Price history per source (amazon, camelcamelcamel, keepa): stats, series when obtainable, chart
> image URL, retrieval time and a terms note. Third-party lookups are cached for hours and rate
> limited.

Kind: runs on a computer; read only; pacing: price_history.

| Argument      | Type                                    | Required | Notes                                               |
| ------------- | --------------------------------------- | -------- | --------------------------------------------------- |
| `browser`     | string (max 64 chars)                   | no       | Browser id, name or alias; see Browser selection    |
| `asin`        | string                                  | yes      | 10 characters, A-Z and 0-9                          |
| `sources`     | array of one of 3 values (min 1, max 3) | no       |                                                     |
| `with_images` | boolean                                 | no       | Also return downscaled image blocks (default false) |

**Result.** Planned. Per the registry: per source stats, series when obtainable, chart image URL,
retrieval time and a terms note.

**Expected errors.** `needs_human`, `throttled`, `blocked_by_policy`, `layout_unrecognized`,
`timeout`.

**Notes.** `camelcamelcamel` and `keepa` are third-party sites with their own terms of service;
automated lookups may be against them. The URL policy allowlists only their product, chart and
graph URLs, and the budget is the smallest of all (12 per hour, 60 per day). The registry says
third-party lookups are cached for hours; no cache exists in the code yet.

## Account reads

### `get_cart`

> Active cart items (opaque item id, ASIN, title, variant, price, quantity and options, seller,
> fulfillment, condition, delivery promise, savings, notices), subtotal, and the Saved for later
> section.

Kind: runs on a computer; read only; pacing: cart.

| Argument    | Type                   | Required | Notes                                                 |
| ----------- | ---------------------- | -------- | ----------------------------------------------------- |
| `browser`   | string (max 64 chars)  | no       | Browser id, name or alias; see Browser selection      |
| `max_chars` | integer 2000..120000   | no       | Size budget in characters (default 40000, cap 120000) |
| `cursor`    | string (max 512 chars) | no       | `next_cursor` from a previous response                |

**Result.** Implemented. A page object with `is_empty`, `empty_message`, `active_items`,
`saved_items` (each line: `item_id`, `asin`, `title`, `variant`, `price`, `quantity`, quantity
control and options, `seller`, `ships_from`, fulfillment, `condition`, `delivery`, `in_stock`,
`is_prime`, `subscribe_and_save`, `notices`, `actions`, `details`), counts, `subtotal`, `notices`,
then `other_sections`, `meta` and the truncation fields.

**Errors.** `needs_human` (sign-in or captcha), `throttled`, `blocked_by_policy`,
`layout_unrecognized`, `timeout`.

**Notes.** `item_id` is the opaque per-line id the cart write tools take. When the budget is
exceeded, lists are cut from the end in the order `active_items`, then `saved_items`, then
`other_sections` (cutting active items first looks unintended).

### `list_orders`

> Order history by year or range, including archived and cancelled filters. Paged with a cursor.

Kind: runs on a computer; read only; pacing: account.

| Argument    | Type                                                 | Required | Notes                                                 |
| ----------- | ---------------------------------------------------- | -------- | ----------------------------------------------------- |
| `browser`   | string (max 64 chars)                                | no       | Browser id, name or alias; see Browser selection      |
| `year`      | integer 1995..2100                                   | no       |                                                       |
| `range`     | `last30`, `months-3`                                 | no       |                                                       |
| `filter`    | `orders`, `not_yet_shipped`, `cancelled`, `archived` | no       |                                                       |
| `cursor`    | string (max 512 chars)                               | no       | `next_cursor` from a previous response                |
| `max_chars` | integer 2000..120000                                 | no       | Size budget in characters (default 40000, cap 120000) |

**Result.** Planned. Per the registry: order history by year or range, including archived and
cancelled filters, paged with a cursor.

**Expected errors.** `needs_human`, `throttled`, `layout_unrecognized`, `timeout`.

**Notes.** The registry does not say what happens when both `year` and `range` are given.

### `get_order`

> Full order details: items, prices, totals, shipments and tracking, payment summary (card brand
> and last 4), return and refund status.

Kind: runs on a computer; read only; pacing: account.

| Argument    | Type                  | Required | Notes                                                 |
| ----------- | --------------------- | -------- | ----------------------------------------------------- |
| `browser`   | string (max 64 chars) | no       | Browser id, name or alias; see Browser selection      |
| `order_id`  | string                | yes      | format 111-1234567-1234567                            |
| `max_chars` | integer 2000..120000  | no       | Size budget in characters (default 40000, cap 120000) |

**Result.** Planned. Per the registry: items, prices, totals, shipments and tracking, payment
summary (card brand and last 4), return and refund status.

**Expected errors.** `needs_human`, `throttled`, `not_found`, `layout_unrecognized`, `timeout`.

**Notes.** Read only. The URL policy refuses order edit, cancel and return pages, so those cannot
be reached.

### `get_invoice`

> Invoice for an order: charge breakdown and payment transactions.

Kind: runs on a computer; read only; pacing: account.

| Argument   | Type                  | Required | Notes                                            |
| ---------- | --------------------- | -------- | ------------------------------------------------ |
| `browser`  | string (max 64 chars) | no       | Browser id, name or alias; see Browser selection |
| `order_id` | string                | yes      | format 111-1234567-1234567                       |

**Result.** Planned. Per the registry: the charge breakdown and payment transactions of an order.

**Expected errors.** `needs_human`, `throttled`, `not_found`, `layout_unrecognized`, `timeout`.

**Notes.** Read only.

### `list_subscriptions`

> Subscribe & Save subscriptions and upcoming deliveries (read only).

Kind: runs on a computer; read only; pacing: account.

| Argument    | Type                   | Required | Notes                                                 |
| ----------- | ---------------------- | -------- | ----------------------------------------------------- |
| `browser`   | string (max 64 chars)  | no       | Browser id, name or alias; see Browser selection      |
| `max_chars` | integer 2000..120000   | no       | Size budget in characters (default 40000, cap 120000) |
| `cursor`    | string (max 512 chars) | no       | `next_cursor` from a previous response                |

**Result.** Implemented. Upcoming deliveries (status and date text, ISO delivery date, pictured
items, button labels only) and subscription entries (id, ASIN, title, next delivery, quantity,
frequency, edit path), plus `other_sections`, `meta` and the truncation fields.

**Errors.** `needs_human`, `throttled`, `blocked_by_policy`, `layout_unrecognized`, `timeout`.

**Notes.** Read only. Write actions (manage, skip) are never exposed as handles.

### `list_lists`

> The owner's lists with privacy and item counts.

Kind: runs on a computer; read only; pacing: list.

| Argument  | Type                  | Required | Notes                                            |
| --------- | --------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars) | no       | Browser id, name or alias; see Browser selection |

**Result.** Planned. Per the registry: the owner's lists with privacy and item counts.

**Expected errors.** `needs_human`, `throttled`, `layout_unrecognized`, `timeout`.

**Notes.** The list ids it returns are the `list_id` values the other list tools take.

### `get_list`

> Items on a list: current price, price drops, added date, quantity wanted, priority, comment,
> availability.

Kind: runs on a computer; read only; pacing: list.

| Argument    | Type                   | Required | Notes                                                 |
| ----------- | ---------------------- | -------- | ----------------------------------------------------- |
| `browser`   | string (max 64 chars)  | no       | Browser id, name or alias; see Browser selection      |
| `list_id`   | string                 | yes      | 8 to 16 characters from list_lists                    |
| `cursor`    | string (max 512 chars) | no       | `next_cursor` from a previous response                |
| `max_chars` | integer 2000..120000   | no       | Size budget in characters (default 40000, cap 120000) |

**Result.** Planned. Per the registry: items with current price, price drops, added date, quantity
wanted, priority, comment and availability.

**Expected errors.** `needs_human`, `throttled`, `not_found`, `layout_unrecognized`, `timeout`.

**Notes.** Each item has an opaque `item_id` for the list write tools.

### `get_browsing_history`

> Recently viewed products.

Kind: runs on a computer; read only; pacing: account.

| Argument    | Type                   | Required | Notes                                                 |
| ----------- | ---------------------- | -------- | ----------------------------------------------------- |
| `browser`   | string (max 64 chars)  | no       | Browser id, name or alias; see Browser selection      |
| `cursor`    | string (max 512 chars) | no       | `next_cursor` from a previous response                |
| `max_chars` | integer 2000..120000   | no       | Size budget in characters (default 40000, cap 120000) |

**Result.** Implemented. `heading`, `history_status` (enabled, disabled, paused or unknown),
`is_empty`, `items` (position, ASIN, title, URL path, price, rating, review count, Prime, delivery
text, badges, viewed group), `all_asins`, `total_items`, `has_more`, `group_headings`, plus
`other_sections`, `meta` and the truncation fields.

**Errors.** `needs_human`, `throttled`, `blocked_by_policy`, `layout_unrecognized`, `timeout`.

**Notes.** The page loads more cards as it scrolls, so the flow scrolls to the bottom six times
before capturing. The per-card remove control appears as a label only.

### `get_search_history`

> Recent searches (best effort; returns `unsupported` with an explanation if Amazon hides it).

Kind: runs on a computer; read only; pacing: account.

| Argument  | Type                  | Required | Notes                                            |
| --------- | --------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars) | no       | Browser id, name or alias; see Browser selection |

**Result.** Planned. Per the registry: recent searches, best effort.

**Expected errors.** `unsupported` with an explanation when Amazon hides the page, plus the usual
read errors.

**Notes.** No page type for it is in the URL allowlist yet, so it cannot work until one is added
deliberately.

## Writes: cart

### `add_to_cart`

> Add ONE specific offer to the cart. Always two-step: offer_id must come from get_buying_options.
> If the offer carries flags (used, no featured offer, price well above typical, slow or
> non-Prime, quantity quirks, unusual purchase type) the add returns needs_choice with the flags
> and alternatives and adds nothing, unless every flag is listed in `acknowledge`. Out of stock is
> never addable. Never subscribes unless purchase_type says so. Returns {changed, before, after}.

Kind: runs on a computer; changes state; pacing: cart.

| Argument        | Type                             | Required | Notes                                            |
| --------------- | -------------------------------- | -------- | ------------------------------------------------ |
| `browser`       | string (max 64 chars)            | no       | Browser id, name or alias; see Browser selection |
| `offer_id`      | string (min 16, max 512 chars)   | yes      |                                                  |
| `quantity`      | integer 1..999                   | no       |                                                  |
| `purchase_type` | `one_time`, `subscribe_and_save` | no       | Default one_time                                 |
| `clip_coupon`   | boolean                          | no       |                                                  |
| `acknowledge`   | array of flags                   | no       | Flags to accept; see Two-step cart adds          |

**Result.** Planned: `{ changed, before, after }` on success, or `needs_choice` with the flags and
alternatives and nothing added.

**Expected errors.** `needs_choice`, `blocked_by_policy`, `needs_human`, `throttled`,
`invalid_arguments`.

**Notes.** Always two-step; see Two-step cart adds. `purchase_type` defaults to `one_time`; the
registry says it never subscribes unless `purchase_type` says so.

### `set_cart_quantity`

> Set the quantity of a cart item (item_id from get_cart). Returns {changed, before, after}.

Kind: runs on a computer; changes state; pacing: cart.

| Argument   | Type                          | Required | Notes                                            |
| ---------- | ----------------------------- | -------- | ------------------------------------------------ |
| `browser`  | string (max 64 chars)         | no       | Browser id, name or alias; see Browser selection |
| `item_id`  | string (min 4, max 256 chars) | yes      |                                                  |
| `quantity` | integer 1..999                | yes      |                                                  |

**Result.** Planned: `{ changed, before, after }`.

**Expected errors.** `needs_human`, `throttled`, `not_found`, `layout_unrecognized`, `timeout`.

**Notes.** `item_id` comes from `get_cart`.

### `remove_from_cart`

> Remove an item from the cart. Returns {changed, before, after}.

Kind: runs on a computer; destructive; pacing: cart.

| Argument  | Type                          | Required | Notes                                            |
| --------- | ----------------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars)         | no       | Browser id, name or alias; see Browser selection |
| `item_id` | string (min 4, max 256 chars) | yes      |                                                  |

**Result.** Planned: `{ changed, before, after }`.

**Expected errors.** `needs_human`, `throttled`, `not_found`, `layout_unrecognized`, `timeout`.

**Notes.** Marked destructive in the MCP annotations.

### `save_for_later`

> Move a cart item to Saved for later. Returns {changed, before, after}.

Kind: runs on a computer; changes state; pacing: cart.

| Argument  | Type                          | Required | Notes                                            |
| --------- | ----------------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars)         | no       | Browser id, name or alias; see Browser selection |
| `item_id` | string (min 4, max 256 chars) | yes      |                                                  |

**Result.** Planned: `{ changed, before, after }`.

**Expected errors.** `needs_human`, `throttled`, `not_found`, `layout_unrecognized`, `timeout`.

**Notes.** Moves the line to the Saved for later section.

### `move_to_cart`

> Move a Saved for later item back to the cart. Returns {changed, before, after}.

Kind: runs on a computer; changes state; pacing: cart.

| Argument  | Type                          | Required | Notes                                            |
| --------- | ----------------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars)         | no       | Browser id, name or alias; see Browser selection |
| `item_id` | string (min 4, max 256 chars) | yes      |                                                  |

**Result.** Planned: `{ changed, before, after }`.

**Expected errors.** `needs_human`, `throttled`, `not_found`, `layout_unrecognized`, `timeout`.

**Notes.** Moves a Saved for later line back into the cart.

### `delete_saved_item`

> Delete a Saved for later item. Returns {changed, before, after}.

Kind: runs on a computer; destructive; pacing: cart.

| Argument  | Type                          | Required | Notes                                            |
| --------- | ----------------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars)         | no       | Browser id, name or alias; see Browser selection |
| `item_id` | string (min 4, max 256 chars) | yes      |                                                  |

**Result.** Planned: `{ changed, before, after }`.

**Expected errors.** `needs_human`, `throttled`, `not_found`, `layout_unrecognized`, `timeout`.

**Notes.** Marked destructive in the MCP annotations.

## Writes: lists

### `create_list`

> Create a list. Returns {changed, before, after}.

Kind: runs on a computer; changes state; pacing: list.

| Argument  | Type                          | Required | Notes                                            |
| --------- | ----------------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars)         | no       | Browser id, name or alias; see Browser selection |
| `name`    | string (min 1, max 100 chars) | yes      |                                                  |
| `privacy` | `private`, `shared`, `public` | no       | Default private                                  |

**Result.** Planned: `{ changed, before, after }`.

**Expected errors.** `needs_human`, `throttled`, `layout_unrecognized`, `timeout`.

**Notes.** `privacy` defaults to `private`.

### `update_list`

> Rename a list and/or change its privacy. Returns {changed, before, after}.

Kind: runs on a computer; changes state; pacing: list.

| Argument  | Type                          | Required | Notes                                            |
| --------- | ----------------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars)         | no       | Browser id, name or alias; see Browser selection |
| `list_id` | string                        | yes      | 8 to 16 characters from list_lists               |
| `name`    | string (min 1, max 100 chars) | no       |                                                  |
| `privacy` | `private`, `shared`, `public` | no       |                                                  |

**Result.** Planned: `{ changed, before, after }`.

**Expected errors.** `needs_human`, `throttled`, `not_found`, `layout_unrecognized`, `timeout`.

**Notes.** Changing `privacy` to `public` or `shared` exposes the list to other people; the tool
does not ask for confirmation, the model should.

### `delete_list`

> Delete a list. Returns {changed, before, after}.

Kind: runs on a computer; destructive; pacing: list.

| Argument  | Type                  | Required | Notes                                            |
| --------- | --------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars) | no       | Browser id, name or alias; see Browser selection |
| `list_id` | string                | yes      | 8 to 16 characters from list_lists               |

**Result.** Planned: `{ changed, before, after }`.

**Expected errors.** `needs_human`, `throttled`, `not_found`, `layout_unrecognized`, `timeout`.

**Notes.** Marked destructive in the MCP annotations.

### `add_to_list`

> Add a product to a list. Returns {changed, before, after}.

Kind: runs on a computer; changes state; pacing: list.

| Argument  | Type                  | Required | Notes                                            |
| --------- | --------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars) | no       | Browser id, name or alias; see Browser selection |
| `list_id` | string                | yes      | 8 to 16 characters from list_lists               |
| `asin`    | string                | yes      | 10 characters, A-Z and 0-9                       |

**Result.** Planned: `{ changed, before, after }`.

**Expected errors.** `needs_human`, `throttled`, `not_found`, `layout_unrecognized`, `timeout`.

### `remove_from_list`

> Remove an item from a list (item_id from get_list). Returns {changed, before, after}.

Kind: runs on a computer; destructive; pacing: list.

| Argument  | Type                          | Required | Notes                                            |
| --------- | ----------------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars)         | no       | Browser id, name or alias; see Browser selection |
| `list_id` | string                        | yes      | 8 to 16 characters from list_lists               |
| `item_id` | string (min 4, max 256 chars) | yes      |                                                  |

**Result.** Planned: `{ changed, before, after }`.

**Expected errors.** `needs_human`, `throttled`, `not_found`, `layout_unrecognized`, `timeout`.

**Notes.** `item_id` comes from `get_list`. Marked destructive in the MCP annotations.

### `update_list_item`

> Set quantity wanted, priority and/or comment on a list item. Returns {changed, before, after}.

Kind: runs on a computer; changes state; pacing: list.

| Argument          | Type                                         | Required | Notes                                            |
| ----------------- | -------------------------------------------- | -------- | ------------------------------------------------ |
| `browser`         | string (max 64 chars)                        | no       | Browser id, name or alias; see Browser selection |
| `list_id`         | string                                       | yes      | 8 to 16 characters from list_lists               |
| `item_id`         | string (min 4, max 256 chars)                | yes      |                                                  |
| `quantity_wanted` | integer 1..999                               | no       |                                                  |
| `priority`        | `lowest`, `low`, `medium`, `high`, `highest` | no       |                                                  |
| `comment`         | string (max 500 chars)                       | no       |                                                  |

**Result.** Planned: `{ changed, before, after }`.

**Expected errors.** `needs_human`, `throttled`, `not_found`, `layout_unrecognized`, `timeout`.

**Notes.** Any of `quantity_wanted`, `priority` and `comment` may be given.

### `move_list_item`

> Move (or with copy: true, copy) an item to another list. Returns {changed, before, after}.

Kind: runs on a computer; changes state; pacing: list.

| Argument     | Type                          | Required | Notes                                            |
| ------------ | ----------------------------- | -------- | ------------------------------------------------ |
| `browser`    | string (max 64 chars)         | no       | Browser id, name or alias; see Browser selection |
| `list_id`    | string                        | yes      | 8 to 16 characters from list_lists               |
| `item_id`    | string (min 4, max 256 chars) | yes      |                                                  |
| `to_list_id` | string                        | yes      | 8 to 16 characters from list_lists               |
| `copy`       | boolean                       | no       |                                                  |

**Result.** Planned: `{ changed, before, after }`.

**Expected errors.** `needs_human`, `throttled`, `not_found`, `layout_unrecognized`, `timeout`.

**Notes.** With `copy: true` the item stays on the source list.

## Diagnostics

### `get_status`

> Hub and per-device state: versions, online, pacing budget left, cool-downs, parser health.

Kind: answered by the Worker; read only; pacing: none.

| Argument  | Type                  | Required | Notes                                            |
| --------- | --------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars) | no       | Browser id, name or alias; see Browser selection |

**Result.** `{ hub: { protocol, min_daemon_version, pending_calls }, browsers: [...] }` with the
same browser rows as `list_browsers`.

**Errors.** `invalid_arguments`.

**Notes.** The registry description also promises the pacing budget left and parser health per
device. The code does not return them yet (it also ignores the `browser` argument), so use
`list_browsers` for `cooling_down_until`. Planned.

### `get_audit_log`

> Recent tool calls: time, client, tool, browser, outcome, duration, error code; arguments for
> write tools only. Never page content. 90-day retention.

Kind: answered by the Worker; read only; pacing: none.

| Argument      | Type                                        | Required | Notes                                        |
| ------------- | ------------------------------------------- | -------- | -------------------------------------------- |
| `limit`       | integer 1..500                              | no       |                                              |
| `before`      | integer -9007199254740991..9007199254740991 | no       | Only rows older than this epoch-ms timestamp |
| `tool`        | string (max 64 chars)                       | no       |                                              |
| `writes_only` | boolean                                     | no       |                                              |

**Result.** `{ rows: [...] }`, newest first. Each row: `ts` (epoch ms), `client` (OAuth client
name), `tool`, `device_id`, `browser` (name), `outcome` (`ok` or `error`), `duration_ms`,
`error_code`, `args` (parsed JSON or null).

**Errors.** `invalid_arguments`.

**Notes.** Arguments are recorded for write tools only (plus `select_browser`), never page
content. Calls refused before they reach a computer (unknown tool, schema failure) are recorded
too. Rows are kept 90 days. `writes_only` returns the rows that carry arguments. `limit` defaults
to 100.
