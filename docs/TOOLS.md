# Tools

Every tool the server exposes, taken from the registry in `packages/core/src/tools.ts`. The registry
is the single source of truth: the Worker publishes it through MCP `tools/list`, validates
every call against it, and the daemon validates again with the same schemas.

A test (`packages/core/test/docs.test.ts`) fails when this file lacks a level-3 heading made of the
tool name in backticks for a registered tool, or has one for a tool that is not registered. Use that
heading form for tools only.

## Status

The registry describes 35 tools. Four are answered by the hub and 31 are implemented in the daemon
(exactly the keys of `FLOWS` in `packages/daemon/src/flows/index.ts`); no tool is planned as a
whole. This table is the one place that records which options are still planned; check `FLOWS` for
the current set.

| Where it runs      | Tools                                                                                                                                                                                                                                                                                     | State                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Worker (hub tools) | `list_browsers`, `select_browser`, `get_status`, `get_audit_log`                                                                                                                                                                                                                          | Implemented                                                                        |
| Daemon, reads      | `search`, `get_product`, `get_variants`, `get_buying_options`, `get_media`, `get_reviews`, `get_review_summary`, `get_price_history`, `get_cart`, `list_orders`, `get_order`, `get_invoice`, `list_subscriptions`, `list_lists`, `get_list`, `get_browsing_history`, `get_search_history` | Implemented                                                                        |
| Daemon, hand-off   | `show_on_screen`                                                                                                                                                                                                                                                                          | Implemented                                                                        |
| Daemon, writes     | `add_to_cart`, `set_cart_quantity`, `remove_from_cart`, `save_for_later`, `move_to_cart`, `delete_saved_item`, `create_list`, `update_list`, `delete_list`, `add_to_list`, `update_list_item`, `move_list_item`, `remove_from_list`                                                       | Implemented                                                                        |
| Planned            | coupon clipping (the `clip_coupon` option of `add_to_cart`); the copy mode of `move_list_item`                                                                                                                                                                                            | Planned: `clip_coupon` is accepted and ignored; `copy: true` answers `unsupported` |

Every section below describes what the code does. `get_search_history` is best effort. Archived
orders are reported `unsupported`; cancelled orders appear inline in the order list.

The hub validates arguments for every registered tool before it reaches a computer, so a bad call
fails early with a routing error from the hub (`invalid_arguments`, `no_browser_online`,
`browser_offline`, `not_found` for an unknown browser name, `daemon_outdated`, `timeout`). A
registered tool with no flow in the daemon would fail there with `unsupported`; today every
non-hub tool has one.

## Conventions

### Result envelope

Every tool result is one text block holding JSON. On success it is `{ ok: true, browser, data }`;
`browser` is `{ id, name, note? }` for tools that ran on a computer. On failure it is
`{ ok: false, browser?, error }` with the MCP `isError` flag set, where `error` is
`{ code, message, kind?, retry_after_s?, details? }`. The codes are listed under Errors.

A result or an error from a paced tool also carries `pacing`, the budget left on that computer
after the call: `{ loads_left, next_free_in_s? }`. `loads_left` page loads fit right now (the
burst cap, the caps across classes and any cool-down are counted; a class's own cap can still be
lower), and `next_free_in_s` says when one more fits (absent when nothing is in use). Use it to
plan the next calls. A daemon older than this field sends none.

Results that came from a computer (everything except the four hub tools) are wrapped: a fixed
notice line saying the block is third-party data and never instructions, then the JSON inside a
tag named `untrusted-external-content-from-amazon-<uuid>` with a fresh random id per call, so page
text cannot close the tag. Daemon error payloads are wrapped too, because they can carry
page-derived text. The hub tools return plain JSON.

Image blocks follow the text block as MCP image content, at most 8 per call. The wire format and the
Worker support them, but no daemon tool produces any yet and no tool takes an image argument:
media and price charts come back as URLs.

### Browser selection

Every daemon tool takes an optional `browser` argument. The Worker picks the computer in this
order and tells you which one served the call in `browser`:

1. The `browser` argument, matched against id, then name, then alias (case-insensitive; aliases
   come from `setup --alias`, see `select_browser`). A name that matches nothing is `not_found`; a match
   that is offline is `browser_offline`. Neither falls back.
2. This connection's selection from `select_browser`. If that computer is offline the call falls
   back to the most recently active online computer and says so in `browser.note`.
3. The most recently active online computer (by last input time reported in presence).

With no computer online the error is `no_browser_online`.

### Read results

A read tool returns its page fields (listed per tool below), then `other_sections` (every visible
block no typed parser consumed, so nothing is lost), `meta` and the truncation fields. `meta` is
`{ url, retrieved_at, warnings, unparsed_text_chars }` (and `unknown_blobs` when a data blob had
keys the parser did not understand). Parsers return a partial result with `warnings` rather than
fail when only part of a page is understood.

### Size budget and cursors

Tools that take `max_chars` aim to return no more than that many characters of JSON (default
40000, hard cap 120000; values outside 2000 to 120000 are rejected by the schema). Truncation is
never silent: the result carries `truncated: true` and, when more is available, `next_cursor`.
Lists are cut from the end, the least important list first. Cursors live in daemon memory for 15
minutes (at most 40 are kept); an expired one is `not_found` and you repeat the call without it.
If nothing is left to cut, the result is a `partial_json` string with a note to raise `max_chars`.
The Worker refuses any daemon result whose data exceeds the hard cap plus 20000 characters.

Only tools that have a `cursor` argument can continue a cut result: `get_product`, `get_variants`,
`get_cart`, `list_subscriptions`, `get_list`, `get_browsing_history` and `list_orders`. Pass
`next_cursor` as `cursor` to continue the same parsed page without loading Amazon again; a
continuation returns only the paged lists. The other read tools (`search`, `get_buying_options`,
`get_reviews`, `get_order`, `get_invoice`, `list_lists`, `get_media`, `get_review_summary`) can still
return a `next_cursor`, but their flows never redeem one, so the registry gives them no `cursor`
argument. Their descriptions say how to get the rest: raise `max_chars` where the tool has one
(`search`, `get_buying_options`, `get_reviews`, `get_order`); `get_invoice`, `list_lists`,
`get_media` and `get_review_summary` have neither argument and the rest cannot be fetched.

### Pacing classes

Each tool names a pacing class. The daemon loads one page at a time per computer, waits a random 5
to 11 seconds between loads, and enforces caps on every load (counted per rolling hour and per
rolling day, persisted across restarts): one cap per class, one cap across all classes together,
and a burst cap of 6 loads in any 10 minutes. Hitting a cap or a cool-down returns `throttled` with
`retry_after_s`, which is the real wait computed from the recorded load times: waiting exactly
that long is enough, and waiting longer gains nothing. A captcha, a sign-in prompt or any other human-only page starts a 60 minute
cool-down for the whole computer (10 minutes when Amazon itself throttles). At most 4 calls may be
running or waiting on one computer; the fifth fails with `busy`.

All of this is per computer. Amazon counts the account, and one account is often driven from two
computers, so each computer gets only half of what a single browser was seen to tolerate and the
two together add up. Multi-step flows check that every page load they need fits the budget, and
return `throttled` before touching anything if it does not. The check runs when the call is made
and again once the call has the browser to itself, so calls queued ahead of it cannot spend the
budget underneath it. `retry_after_s` is then the time until all of the flow's loads fit, and
`details` is `{ needed, available, limited_by? }`: `limited_by` names the page class whose own cap
is what falls short, when it is not the caps across classes.

What each tool costs in page loads:

| Tool                                                                               | Loads                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `search`, `get_cart`, the order, subscription, history and list reads              | 1                                                                        |
| `get_product`, `get_variants`, `get_media`, `get_review_summary`                   | 1 for the first of them on an ASIN, then 0 for two minutes (shared page) |
| `get_buying_options`                                                               | 2, or 1 right after a product read of the same ASIN                      |
| `get_reviews`                                                                      | 1, plus 1 per page after the first                                       |
| `add_to_cart`                                                                      | 4                                                                        |
| `remove_from_cart`, `save_for_later`, `move_to_cart`, `delete_saved_item`          | 2                                                                        |
| `set_cart_quantity`                                                                | 2, plus 1 for each step that has to be read back                         |
| the list writes                                                                    | 2 to 4                                                                   |
| `show_on_screen`, `list_browsers`, `select_browser`, `get_status`, `get_audit_log` | 0                                                                        |

With the default caps a task that needs more than 6 loads waits out the 10 minute window between
bursts: one search plus one cart add (1 + 2 + 4 loads) is already 7.

| Class           | Per hour | Per day | Used by                                                                                                                                                                |
| --------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`        | 15       | 100     | `search`, `get_search_history`                                                                                                                                         |
| `product`       | 15       | 120     | `get_product`, `get_variants`, `get_media`, `get_review_summary`, the product page of `get_buying_options` and `add_to_cart`, the Amazon source of `get_price_history` |
| `offers`        | 15       | 100     | the all-offers fragment of `get_buying_options`                                                                                                                        |
| `reviews`       | 15       | 120     | `get_reviews` (each "show more" expansion counts as a load)                                                                                                            |
| `account`       | 12       | 80      | `list_orders`, `get_order`, `get_invoice`, `list_subscriptions`, `get_browsing_history`                                                                                |
| `cart`          | 15       | 120     | `get_cart` and the cart write tools                                                                                                                                    |
| `list`          | 12       | 80      | `list_lists`, `get_list` and the list write tools                                                                                                                      |
| `price_history` | 6        | 30      | the CamelCamelCamel source of `get_price_history`                                                                                                                      |
| all classes     | 15       | 200     | every load above together (and at most 6 in any 10 minutes)                                                                                                            |

`show_on_screen` has class `none`: it does not count against any budget. The hub tools have no
class. The class in each tool's entry is the registry's hint; the code decides by the page it
loads. A tool that loads more than one kind of page is listed under the class of its main page:
`get_buying_options` (product page, then the offers fragment), `add_to_cart` (product page, then the
cart), `get_variants` with `fetch_missing` and `get_price_history` (several sources). The table
above is what the code does.

The owner can change the caps for one computer in that computer's `config.json` (docs/SETUP.md,
"Pacing caps for one computer"); the defaults above do not move, and the ceilings are 20 loads per
10 minutes, 40 per hour and 400 per day. `list_browsers` and `get_status` show the burst cap in
force and what is left of it in `pacing_burst`, and the remaining budget per class in
`pacing_budget`.

### Two-step cart adds

Adding to the cart is deliberately a two-step flow. Step one is `get_buying_options`, which returns
offers with short-lived opaque `offer_id` values and per-offer flags. Step two is `add_to_cart`
with exactly one `offer_id`; ASIN-only adds do not exist. An `offer_id` is an authenticated
encrypted token that only the daemon that made it can read: it expires after about thirty minutes
(longer than the 10 minute burst window, so it survives a wait for the budget),
dies when the daemon restarts and cannot be forged or altered by the hub or the model. If the
chosen offer carries any flag, the add fails with `needs_choice` and adds nothing, unless every
flag on the offer is listed in `acknowledge`. `out_of_stock` can never be acknowledged. A price or
seller that changed since step one, or an offer that is gone, is also `needs_choice`. Only
`one_time` purchases are added; Subscribe & Save is refused by design (see `add_to_cart`).

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

| Code                  | Meaning                                                                                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `needs_human`         | Amazon showed a page only the owner can handle (sign-in, captcha, checkpoint; it is never solved). Do it by hand, then retry after the 60 minute cool-down. `details`: `cooling_down_until`, `while_opening`, `seen` (`redirect`, `landed` or `page`), `friction_path`, `evidence` |
| `throttled`           | A pacing cap or cool-down applies, or a flow needs more page loads than fit right now; wait exactly `retry_after_s` (absent when the need exceeds a cap)                                                                                                                           |
| `no_browser_online`   | No paired computer is connected                                                                                                                                                                                                                                                    |
| `browser_offline`     | The named computer is offline, dropped mid-call, or its extension cannot be reached                                                                                                                                                                                                |
| `busy`                | That computer already has 4 calls running or waiting; retry in about 15 seconds                                                                                                                                                                                                    |
| `not_found`           | Unknown browser name, a page Amazon says does not exist, or an expired cursor                                                                                                                                                                                                      |
| `layout_unrecognized` | The page was not understood, or Amazon returned an error page                                                                                                                                                                                                                      |
| `blocked_by_policy`   | The URL policy, the network guard or the click guard refused a navigation, fragment, redirect or click, or an add asked for Subscribe & Save                                                                                                                                       |
| `needs_choice`        | `add_to_cart` refused the offer and added nothing (`details.reason`: `flags`, `price_changed`, `seller_changed`, `offer_gone`, `out_of_stock`)                                                                                                                                     |
| `daemon_outdated`     | The computer's daemon is older than the hub requires and is updating; retry in about 60 seconds                                                                                                                                                                                    |
| `hub_outdated`        | Defined, and used as a WebSocket close reason when a daemon speaks a newer protocol than the hub                                                                                                                                                                                   |
| `invalid_arguments`   | The arguments do not match the tool schema, or the tool name is unknown                                                                                                                                                                                                            |
| `unsupported`         | The request asks for something not implemented (`move_list_item` with `copy: true`) or Amazon does not offer the page (archived orders, search history)                                                                                                                            |
| `timeout`             | The 225 second call deadline or the 45 second page load limit passed                                                                                                                                                                                                               |
| `internal`            | Anything else; the message never carries the underlying error text                                                                                                                                                                                                                 |

## Browsers

### `list_browsers`

> List the owner's computers that can drive Amazon: stable id, name, aliases, OS, online, last
> active, idle/locked, Chrome running, Amazon signed in, daemon version, and whether it is this
> connection's selection. Also each computer's pacing: pacing_burst ({cap, window_s, left,
> next_free_in_s, all_free_in_s}: `left` page loads fit right now) and pacing_budget (hour_left and
> day_left per page type). Costs no page load.

Kind: answered by the Worker; read only; pacing: none.

This tool takes no arguments.

**Result.** `{ browsers: [...] }`. Each row: `id`, `name`, `aliases`, `os`, `online`, `last_seen`,
`last_active`, `idle_s`, `locked`, `chrome_running`, `profile_connected`, `amazon_signed_in`,
`cooling_down_until`, `daemon_version`, `pacing_budget`, `pacing_burst`, `selected`. Presence
fields are null when the computer is offline or has not reported yet. `pacing_budget` maps each
page type (and `all`, the cap across types) to `{ hour_left, day_left }`. `pacing_burst` is
`{ cap, window_s, left, next_free_in_s?, all_free_in_s? }`: `left` of `cap` page loads fit right
now in any `window_s` seconds, one more fits in `next_free_in_s` and the whole cap is free again
in `all_free_in_s` (both absent when nothing is in use); the hub works it out at read time from
the load times the daemon reported, and the daemon reports after every paced call. It is null for
a daemon that does not report it. Revoked devices are not listed.

**Errors.** `invalid_arguments`.

**Notes.** Answered by the Worker itself; no computer is contacted. `selected` is true for the row
chosen by `select_browser` on this connection. `aliases` are the extra names set with
`rainforestd setup --alias` on that computer; the daemon reports them in its presence frame.

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
then alias. Aliases come from each computer's local config (`setup --alias`) and reach the hub
with the computer's presence, so a new alias works once that daemon has connected.

### `show_on_screen`

> Open an amazon.com product, cart, list or order page in a NORMAL (non-automation) tab on the
> chosen computer and bring it to the front, so the owner can finish something (for example
> checkout) by hand. This is the only way to reach checkout: placing orders is not possible through
> this server.

Kind: runs on a computer; changes state; pacing: none.

| Argument  | Type                  | Required | Notes                                            |
| --------- | --------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars) | no       | Browser id, name or alias; see Browser selection |
| `target`  | object                | yes      | Which page to open; see below                    |

**Result.** `{ changed: true, opened, note }`, where `opened` is the amazon.com URL that was
opened.

**Errors.** `invalid_arguments` (the daemon re-validates the target), `throttled` (the tab cap),
`browser_offline`.

**Notes.** The hand-off is how a purchase gets finished: the daemon builds the URL itself from the
typed `target` (never from a caller-supplied URL), starts the configured Chrome profile on that
URL in a normal tab and brings it forward. The automation session never attaches to that tab, and
it does not count against any pacing budget; at most 6 tabs are opened in any 10 minutes per computer, after which the call fails with `throttled` and `retry_after_s`. The URL policy and network guard cover only the
automation tab, so they do not apply to this one: it is your own browsing from there. `target` is
one of: `{type: product, asin}`, `{type: cart}`, `{type: list, list_id}`, `{type: order,
order_id}`, `{type: orders}`. Registered as a write tool, so the Worker records its arguments in
the audit log.

## Catalog reads

### `search`

> Search amazon.com, one results page per call. Every result is labeled organic or sponsored (kind +
> is_sponsored). Returns results, widgets (carousels/shelves with their own sponsored flag), all
> available refinements grouped (each option has an opaque token), sort options, applied filters,
> corrections and pagination. Beyond query, department, sort, min_price, max_price and brand, filter
> by passing a refinement token from a previous response in `refinements` (Prime, star rating,
> condition, any left-rail filter). Tokens are cumulative: only the last one is applied, and it
> replaces query, department and brand. A result over the budget is cut (truncated: true); this tool
> takes no cursor, so raise max_chars to get the rest.

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
| `brand`       | string (max 100 chars)                                                                                | no       |                                                                                 |
| `condition`   | `new`, `used`, `renewed`                                                                              | no       |                                                                                 |
| `refinements` | array of string (max 30)                                                                              | no       | Opaque refinement tokens from a previous search response (any left-rail filter) |
| `max_chars`   | integer 2000..120000                                                                                  | no       | Size budget in characters (default 40000, cap 120000)                           |

**Result.** Implemented. `query`, `department`, `total_results_text`, `result_range`, `results`
(each result carries `kind` and `is_sponsored`, the `sponsored_signals` that fired, and the product
fields the card showed), `widgets` (carousels and shelves with their own sponsored flag and
items), `refinements` (grouped options, each with an opaque `token`), `applied_filters`,
`sort_options`, `pagination`, `corrections` and `hidden_skipped`, then `other_sections`, `meta` and the truncation fields (see Read results). `filter_notes` is added
when several refinement tokens were given (see Notes).

**Errors.** `needs_human`, `throttled`, `blocked_by_policy`, `layout_unrecognized`, `timeout`, `invalid_arguments`.

**Notes.** `query`, `department`, `sort`, `page`, `min_price`, `max_price` and `brand` are put in
the search URL. There are no Prime, star-rating or condition arguments: to filter by any left-rail
filter, pick the matching option from `refinements` in a previous response and pass its token.
`refinements` takes the tokens of a previous response (each is that page's own relative search
URL for the filter); tokens are cumulative, so only the last one given is applied (and `filter_notes`
says so), and one that is not a relative `/s` search URL is `invalid_arguments`. The applied token
replaces `query`, `department` and `brand`; `sort`, `page`, `min_price` and `max_price` are still
added to its URL. When the result is too big the lists are cut
in the order `other_sections`, `widgets`, `refinements`, `results`; this tool has no `cursor`
argument, so raise `max_chars` instead of paging.

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

**Result.** Implemented. `asin`, `parent_asin`, `title`, `title_differentiators`, `byline`,
`breadcrumbs`, `department`, `best_seller_ranks`, `product_type`, `buy_box` (one of a fixed set of
states), `featured_offer`, `purchase_options`, `other_sellers`, `variant_summary`, `media_counts`,
`rating`, `highlights`, `bullets`, `description`, `aplus_text`, `overview`, `spec_tables`,
`important_information`, `whats_in_the_box`, `documents`, `notices`, `sponsored_blocks`, `related`,
`grocery`, `nutrition` and `price_history_ingress`, then `other_sections`, `meta` and the truncation fields (see Read results).

**Errors.** `needs_human`, `throttled`, `blocked_by_policy`, `layout_unrecognized`, `timeout`, `not_found`.

**Notes.** Long pages are cut at the size budget (lists `other_sections`, `related`,
`sponsored_blocks` first) and continue with `cursor`. The product page capture is kept in memory
for two minutes and shared with `get_variants`, `get_media`, `get_review_summary` and the Amazon
source of `get_price_history`, so calling several of them in a row loads the page once.

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

**Result.** Implemented. `parent_asin`, `current_asin`, `dimensions`, `combinations` (the
combination to child ASIN map with per-variant price, availability and delivery where the page
shows them), `total_variations`, `combinations_complete` and `missing_offer_asins`; with
`fetch_missing` above 0 also `fetched_offers`, one entry per child page loaded (or an error code
for that child). then `other_sections`, `meta` and the truncation fields (see Read results).

**Errors.** `needs_human`, `throttled`, `blocked_by_policy`, `layout_unrecognized`, `timeout`, `not_found`.

**Notes.** `fetch_missing` loads child product pages (at most the number asked for, taken from
`missing_offer_asins`), each counted against the `product` pacing budget; a throttle or a
human-only page on a child stops the call with that error.

### `get_buying_options`

> The featured offer (if any) plus ALL offers (new, used, renewed). Each offer has a short-lived
> opaque offer_id (required by add_to_cart), price, shipping, total, condition, seller, ships-from,
> fulfillment, Prime, delivery promise, quantity limits and flags. Also purchase types (one-time,
> Subscribe & Save) and clippable coupons (listed only; clipping is not implemented). An offer_id
> expires after about 30 minutes. Costs 2 page loads (the product page and its offers panel), or 1
> when the previous call was a product read of the same ASIN; refused with throttled before loading
> anything when they do not fit. A result over the budget is cut (truncated: true); this tool takes
> no cursor, so raise max_chars to get the rest.

Kind: runs on a computer; read only; pacing: offers.

| Argument    | Type                            | Required | Notes                                                 |
| ----------- | ------------------------------- | -------- | ----------------------------------------------------- |
| `browser`   | string (max 64 chars)           | no       | Browser id, name or alias; see Browser selection      |
| `asin`      | string                          | yes      | 10 characters, A-Z and 0-9                            |
| `condition` | `all`, `new`, `used`, `renewed` | no       |                                                       |
| `max_chars` | integer 2000..120000            | no       | Size budget in characters (default 40000, cap 120000) |

**Result.** Implemented. `product`, `pinned_offer` (the featured offer, or null), `offers`,
`total_offer_count`, `no_offers`, `no_featured_offer`, `purchase_types`, `coupons`, `promotions`,
`typical_price`, `list_price`, `featured_price`, `buybox` and the other page-level fields, then `other_sections`, `meta` and the truncation fields (see Read results).
Each offer carries its price, shipping, total, condition, seller, ships-from, fulfillment, Prime,
delivery promise and quantity limits, plus `flags` (from the list under Two-step cart adds),
`out_of_stock` and `offer_id`. Identifiers that would let a caller address an offer directly are
removed. An offer that cannot be added from here has `offer_id: null` and an `offer_id_note`.

**Errors.** `needs_human`, `throttled`, `blocked_by_policy`, `layout_unrecognized`, `timeout`, `not_found`.

**Notes.** Step one of a cart add. The `offer_id` is the only input `add_to_cart` accepts: it is an
authenticated encrypted token, made by the daemon, that expires after about thirty minutes and stops
working when the daemon restarts. The tool loads the product page (`product` class) and then the
all-offers fragment (`offers` class, the one fragment URL on the allowlist). When the tab still
shows that product page from a product read in the last two minutes, the page is not loaded
again and only the fragment counts; in turn the page this tool loads serves the product reads for
two minutes. Both loads must fit the budget before either is made (`throttled` otherwise, with
nothing loaded). If the fragment
cannot be loaded the parser falls back to the buy box and says so in `meta.warnings`. `condition`
filters the offers returned. Flags are computed assuming the account has Prime. There is no
`cursor` argument: when the result is cut (`other_sections` first, then `offers`) raise
`max_chars`.

### `get_media`

> Hi-res image URLs per variant and videos (title, duration, URL, thumbnail). URLs only: no image
> data is returned. A result over the default 40000-character budget is cut (truncated: true); this
> tool takes neither cursor nor max_chars, so the rest cannot be fetched.

Kind: runs on a computer; read only; pacing: product.

| Argument  | Type                  | Required | Notes                                            |
| --------- | --------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars) | no       | Browser id, name or alias; see Browser selection |
| `asin`    | string                | yes      | 10 characters, A-Z and 0-9                       |

**Result.** Implemented. `asin`, `images` (hi-res URLs), `images_by_variant`, `variant_labels`,
`videos` (title, duration, URL, thumbnail) and `counts`, then `other_sections`, `meta` and the truncation fields (see Read results).

**Errors.** `needs_human`, `throttled`, `blocked_by_policy`, `layout_unrecognized`, `timeout`, `not_found`.

**Notes.** URLs only: no image blocks are produced. This tool has no `max_chars` or `cursor`
argument, so a result cut at the default budget cannot be continued.

### `get_reviews`

> Full review text, ten reviews per page (`page` N returns the Nth block of ten), with sort and
> filters. Each review: rating, title, body, date, verified, variant attributes, helpful votes,
> media, badges. A result over the budget is cut (truncated: true); this tool takes no cursor, so
> raise max_chars to get the rest.

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

**Result.** Implemented. `asin`, `product`, `rating`, `rating_count`, `review_count`,
`matching_count`, `histogram`, `filters`, `filter_options`, `reviews` (rating, title, body, date,
verified purchase, variant attributes, helpful votes, author, badges, media, replies), `pagination`,
`is_empty`, `empty_message`, `filter_error`, `page` (the block returned), `page_requested` and, when
fewer pages exist than asked for, `page_note`, then `other_sections`, `meta` and the truncation fields (see Read results).

**Errors.** `needs_human`, `throttled`, `blocked_by_policy`, `layout_unrecognized`, `timeout`, `not_found`.

**Notes.** Amazon loads reviews ten at a time through an in-page "show more" control, so `page` N
loads the first block and expands N-1 times; each expansion is paced and counted as a `reviews`
load, and only block N is returned. `sort` (`top` is Amazon's "helpful" order), `stars`,
`verified_only`, `keyword`, `this_variant_only` and `media_only` are put in the page URL. There is
no `cursor` argument.

### `get_review_summary`

> Rating, count, histogram, the AI 'Customers say' text and aspect chips, top positive and critical
> review. A result over the default 40000-character budget is cut (truncated: true); this tool takes
> neither cursor nor max_chars, so the rest cannot be fetched.

Kind: runs on a computer; read only; pacing: product.

| Argument  | Type                  | Required | Notes                                            |
| --------- | --------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars) | no       | Browser id, name or alias; see Browser selection |
| `asin`    | string                | yes      | 10 characters, A-Z and 0-9                       |

**Result.** Implemented. `asin`, `rating`, `rating_count`, `rating_text`, `histogram`,
`customers_say` (the AI summary), `aspects`, `top_positive_review`, `top_critical_review`,
`featured_reviews`, `other_country_reviews` and `see_all_reviews_path`, then `other_sections`, `meta` and the truncation fields (see Read results).

**Errors.** `needs_human`, `throttled`, `blocked_by_policy`, `layout_unrecognized`, `timeout`, `not_found`.

**Notes.** Read from the product page, so it uses the `product` pacing class (not `reviews`) and
shares the cached page capture with `get_product`. No `cursor` or `max_chars` argument.

### `get_price_history`

> Price history per source (default all three), each entry with a terms note. amazon: the price
> facts the product page shows (series only if the page embeds one). camelcamelcamel: stats, any
> series the page shows and a chart image URL. keepa: a chart image URL and link only
> (series_available: false), no price numbers. Chart URLs are links; no image data is returned. A
> failed lookup is reported inside its entry (unavailable: true). Third-party lookups are cached for
> 6 hours and rate limited.

Kind: runs on a computer; read only; pacing: price_history.

| Argument  | Type                                    | Required | Notes                                            |
| --------- | --------------------------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars)                   | no       | Browser id, name or alias; see Browser selection |
| `asin`    | string                                  | yes      | 10 characters, A-Z and 0-9                       |
| `sources` | array of one of 3 values (min 1, max 3) | no       | Default all three                                |

**Result.** Implemented. `{ asin, amazon?, camelcamelcamel?, keepa? }`, one entry per requested
source (default all three), each with a `terms_note`.

- `amazon`: the price facts the product page itself shows (current, typical and list price,
  savings, statements) and `meta`; `series` is present only when the page embeds one
  (`series_available` and `series_note` say whether).
- `camelcamelcamel`: stats, periods and any series the page shows, plus `chart_image_url` and
  `meta`; a captcha or block page on that site is reported inside the entry (`blocked`).
- `keepa`: `chart_image_url`, `link`, `series_available: false` and `retrieved_at`. Only the chart
  URL is produced; the daemon never loads a Keepa page.

An entry served from the cache has `cached: true`. A failed lookup is reported inside its entry
as `unavailable: true` with the error; a `needs_human` or `throttled` condition stops the whole call
instead.

**Errors.** `needs_human`, `throttled`, `blocked_by_policy`, `layout_unrecognized`, `timeout`.

**Notes.** `camelcamelcamel` and `keepa` are third-party sites with their own terms of service;
automated lookups may be against them. The URL policy allowlists only their product, chart and
graph URLs, and the budget is the smallest of all (6 per hour, 30 per day per computer). Results
are cached in daemon memory for 6 hours per source and ASIN. The CamelCamelCamel lookup loads the
site's product page in your browser. Charts are URLs only, never image blocks.

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
`groups` and `checkout_available`, then `other_sections`, `meta` and the truncation fields (see Read results).

**Errors.** `needs_human` (sign-in or captcha), `throttled`, `blocked_by_policy`,
`layout_unrecognized`, `timeout`.

**Notes.** `item_id` is the opaque per-line id the cart write tools take. When the budget is
exceeded, lists are cut from the end in the order `other_sections`, then `saved_items`, then
`active_items`, so active items survive longest. The write tools read this same page before and
after every change.

### `list_orders`

> Order history, one page per call: `year`, or `range` (last30, months-3), or neither for Amazon's
> default list (`year` wins over `range`). filter: orders (default), not_yet_shipped (open orders),
> cancelled (keeps only the cancelled orders found on the requested page, so a page can come back
> empty while more pages exist), archived (answers unsupported; archived orders still appear under
> their year). When Amazon has a further page the result has next_page_cursor; a result cut for size
> has next_cursor. Pass either as `cursor`.

Kind: runs on a computer; read only; pacing: account.

| Argument    | Type                                                 | Required | Notes                                                 |
| ----------- | ---------------------------------------------------- | -------- | ----------------------------------------------------- |
| `browser`   | string (max 64 chars)                                | no       | Browser id, name or alias; see Browser selection      |
| `year`      | integer 1995..2100                                   | no       |                                                       |
| `range`     | `last30`, `months-3`                                 | no       |                                                       |
| `filter`    | `orders`, `not_yet_shipped`, `cancelled`, `archived` | no       |                                                       |
| `cursor`    | string (max 512 chars)                               | no       | `next_cursor` from a previous response                |
| `max_chars` | integer 2000..120000                                 | no       | Size budget in characters (default 40000, cap 120000) |

**Result.** Implemented. `heading`, `breadcrumbs`, `requested`, `order_count_text`, `order_count`,
`time_filter`, `tabs`, `selected_tab`, `pagination`, `orders` (each card: `order_id`, `order_type`,
`placed`, `total`, `ship_to`, `status_lines`, `shipments`, `actions`, `is_cancelled`,
`has_cancelled_shipment`, `is_archived`, `return_or_refund`, `item_count`, paths to the details and
the invoice), `empty_text`, `search` and `links`, then `other_sections`, `meta` and the truncation fields (see Read results). When Amazon has a next page the result
also has `next_page_cursor`.

**Errors.** `needs_human`, `throttled`, `blocked_by_policy`, `layout_unrecognized`, `timeout`, `unsupported` (the `archived` filter).

**Notes.** `year` becomes the time filter `year-N` and `range` is `last30` or `months-3`; `year`
wins when both are given. `not_yet_shipped` maps to Amazon's open-orders filter. Amazon has no
cancelled-only list: cancelled orders appear inline in the normal list, so `cancelled` keeps only
the cancelled ones on each page (and says so in `filter_note`); continue with the next page for
more. `archived` is answered `unsupported`: Amazon's current order list has no archived view, and
archived orders still appear under their year. Two kinds of cursor go in `cursor`: `next_page_cursor`
fetches the next page of Amazon's list, and `next_cursor` continues a result that was cut for size.

### `get_order`

> Full order details: items, prices, totals, shipments and tracking, payment summary (card brand and
> last 4), return and refund status. A result over the budget is cut (truncated: true); this tool
> takes no cursor, so raise max_chars to get the rest.

Kind: runs on a computer; read only; pacing: account.

| Argument    | Type                  | Required | Notes                                                 |
| ----------- | --------------------- | -------- | ----------------------------------------------------- |
| `browser`   | string (max 64 chars) | no       | Browser id, name or alias; see Browser selection      |
| `order_id`  | string                | yes      | format 111-1234567-1234567                            |
| `max_chars` | integer 2000..120000  | no       | Size budget in characters (default 40000, cap 120000) |

**Result.** Implemented. `order_id`, `placed`, `status`, `order_types`, `ship_to`, `payment`
(methods, card brand and last four digits, lines), `totals`, `shipments` (items with ASIN, title,
quantity, price, seller, status; tracking), `returns_and_refunds`, `cancellation`, `notices`,
`links` and `actions` (as labels only), then `other_sections`, `meta` and the truncation fields (see Read results).

**Errors.** `needs_human`, `throttled`, `blocked_by_policy`, `layout_unrecognized`, `timeout`, `not_found` (Amazon could not load that order for this account).

**Notes.** Read only. The URL policy refuses order edit, cancel and return pages, so those cannot
be reached. There is no `cursor` argument; raise `max_chars` if `shipments` are cut.

### `get_invoice`

> Invoice for an order: charge breakdown and payment transactions. A result over the default
> 40000-character budget is cut (truncated: true); this tool takes neither cursor nor max_chars, so
> the rest cannot be fetched.

Kind: runs on a computer; read only; pacing: account.

| Argument   | Type                  | Required | Notes                                            |
| ---------- | --------------------- | -------- | ------------------------------------------------ |
| `browser`  | string (max 64 chars) | no       | Browser id, name or alias; see Browser selection |
| `order_id` | string                | yes      | format 111-1234567-1234567                       |

**Result.** Implemented. `order_id`, `placed`, `order_total`, `order_types`, `ship_to`,
`shipments`, `payment`, `charge_breakdown`, `transactions`, `refunds`, `notices` and `actions`,
then `other_sections`, `meta` and the truncation fields (see Read results).

**Errors.** `needs_human`, `throttled`, `blocked_by_policy`, `layout_unrecognized`, `timeout`, `not_found`.

**Notes.** Read only; reads Amazon's print view of the invoice. No `cursor` or `max_chars` argument.

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

> The owner's lists with privacy and item counts. A result over the default 40000-character budget
> is cut (truncated: true); this tool takes neither cursor nor max_chars, so the rest cannot be
> fetched.

Kind: runs on a computer; read only; pacing: list.

| Argument  | Type                  | Required | Notes                                            |
| --------- | --------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars) | no       | Browser id, name or alias; see Browser selection |

**Result.** Implemented. `variant`, `lists` (each: `list_id`, `name`, `privacy`, `privacy_text`,
`is_default`, `list_kind`, `item_count`, `shared_with_me`, `owner`), `selected_list_id`, `tabs`,
`can_create` and `help_link`, then `other_sections`, `meta` and the truncation fields (see Read results). The items of Amazon's pre-selected list are removed: they
belong to `get_list`.

**Errors.** `needs_human`, `throttled`, `blocked_by_policy`, `layout_unrecognized`, `timeout`.

**Notes.** The list ids it returns are the `list_id` values the other list tools take. No `cursor` or
`max_chars` argument.

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

**Result.** Implemented. `list` (id, name, privacy), `nav_lists`, `filter`, `sort`, `view`,
`items` (each: `item_id`, `asin`, `title`, `price`, `price_drop`, `added`, `quantity_wanted`,
`quantity_has`, `priority`, `comment`, `availability`, `rating`, `prime`, `is_purchased`, actions),
`pagination`, `is_empty` and `extra_text`, then `other_sections`, `meta` and the truncation fields (see Read results).

**Errors.** `needs_human`, `throttled`, `blocked_by_policy`, `layout_unrecognized`, `timeout`, `not_found`.

**Notes.** Each item has an opaque `item_id` for the list write tools. Lists load more items as
they scroll, so the flow scrolls until the end-of-list marker or twelve times, then captures.

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

Kind: runs on a computer; read only; pacing: search.

| Argument  | Type                  | Required | Notes                                            |
| --------- | --------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars) | no       | Browser id, name or alias; see Browser selection |

**Result.** Implemented, best effort. `{ entries, note }`: the recent searches Amazon shows.

**Errors.** `unsupported` with an explanation when Amazon shows no recent searches, plus the usual
read errors.

**Notes.** Amazon shows recent searches only in the dropdown of the empty search box. The flow
loads the home page (an allowlisted page), clicks the search box through the click guard and reads
the dropdown, so the list is short and may be empty. The page load counts against the `search`
pacing class, which is also the class the registry names.

## Writes: cart

### `add_to_cart`

> Add ONE specific offer to the cart, always in two steps: offer_id must come from
> get_buying_options. Costs 4 page loads, checked before anything is touched: when they do not fit
> it adds nothing and fails with throttled, and retry_after_s is the exact wait (the message says so
> if the offer_id will have expired by then). Adds nothing and fails with needs_choice
> (details.reason) when the offer is gone (offer_gone), its price or seller changed (price_changed,
> seller_changed), it is out of stock (out_of_stock, never addable), or it carries flags not all
> listed in `acknowledge` (flags; details list the flags and up to 8 alternatives). Adds exactly one
> unit: quantity above 1 is not applied yet (set_cart_quantity changes the quantity afterwards), and
> coupon clipping is not implemented yet. purchase_type subscribe_and_save is always refused with
> blocked_by_policy, because a subscription is a recurring order; use show_on_screen to finish one
> by hand. Result: {changed, before, after, added, acknowledged_flags, declined_upsells,
> quantity_note}: before/after are cart states, added is the cart line (its item_id works with the
> cart tools), acknowledged_flags the flags the offer carried, declined_upsells the protection-plan
> or add-on prompts the flow answered with no, quantity_note is set when quantity was above 1.

Kind: runs on a computer; changes state; pacing: cart.

| Argument        | Type                             | Required | Notes                                            |
| --------------- | -------------------------------- | -------- | ------------------------------------------------ |
| `browser`       | string (max 64 chars)            | no       | Browser id, name or alias; see Browser selection |
| `offer_id`      | string (min 16, max 4096 chars)  | yes      | From get_buying_options                          |
| `quantity`      | integer 1..999                   | no       | Default 1; only one unit is added; see Notes     |
| `purchase_type` | `one_time`, `subscribe_and_save` | no       | Default one_time; subscribe_and_save is refused  |
| `clip_coupon`   | boolean                          | no       | Not implemented yet; ignored                     |
| `acknowledge`   | array of flags                   | no       | Flags to accept; see Two-step cart adds          |

**Result.** Implemented. On success `{ changed: true, before, after, added, acknowledged_flags,
declined_upsells, quantity_note? }`: `before` and `after` are compact cart states (active lines with
`item_id`, `asin`, `title`, `quantity` and `price`; saved lines; subtotal), `added` is the cart line
for that ASIN, `acknowledged_flags` the flags the offer carried and the caller accepted, and
`declined_upsells` the protection-plan or add-on prompts the flow answered with "no thanks".
`acknowledged_flags` lists every flag the offer carried (all of them were in `acknowledge`, or the
call would have failed) and `quantity_note` is present only when `quantity` was above 1. When the
offer cannot be added as asked the call fails with `needs_choice` and nothing is added; its
`details.reason` is `offer_gone`, `price_changed` (with `was_cents`, `now_cents`), `seller_changed`,
`out_of_stock` or `flags` (with `flags` and `all_flags`), each with up to 8 `alternatives`.

**Errors.** `needs_choice`, `invalid_arguments` (the offer id is invalid or expired),
`blocked_by_policy`, `needs_human`, `throttled`, `layout_unrecognized`, `internal`, `timeout`.

**Notes.** Always two-step; see Two-step cart adds. Deliberate limitations:

- **Subscribe & Save is refused.** A subscription is a recurring order, which this server never
  places. `purchase_type: subscribe_and_save` fails with `blocked_by_policy` and a message that
  points to `show_on_screen`. `one_time` is the only type that works.
- **One unit per call.** `quantity` is used when computing the quantity-related flags, but one unit
  is added; the result says so in `quantity_note`. Changing the quantity afterwards needs
  `set_cart_quantity`.
- **Four page loads, all or nothing.** The flow reads the cart, loads the product page, opens its
  offers panel and reads the cart again. If the four do not fit the pacing budget it adds nothing
  and fails with `throttled`; `retry_after_s` is the time until all four fit, and the message says
  so when the offer id will have expired by then (get a new one from `get_buying_options` first).
- **`clip_coupon` is planned.** It is accepted and ignored.

The flow first checks that three page loads fit the pacing budget (otherwise `throttled`). It then
reads the cart, loads the product page, then navigates from inside that page to the all-offers panel (a direct jump to the panel URL draws a challenge), re-reads the offers from that panel,
finds the one the token was made for (by seller, condition and price), and refuses with
`needs_choice` when it is gone (`offer_gone`), its price or seller changed (`price_changed`,
`seller_changed`), it is out of stock (`out_of_stock`), or it carries flags that were not
acknowledged (`flags`). `details` holds the reason, the flags and up to 8 alternatives. Only then
does it click that offer's own Add to Cart control through the click guard, once and never
retried, answers any upsell with its decline control, reads the cart again and fails with
`internal` (observed state attached) if the cart did not grow by exactly one unit of that ASIN.

### `set_cart_quantity`

> Set the quantity of a cart item (item_id from get_cart) with the line's own quantity stepper, one click per unit, then re-read the cart. At most 20 units of change per call (a larger jump fails with invalid_arguments), and never below 1: use remove_from_cart to remove the item. Returns {changed, before, after, item}: changed is false when the quantity already matches (nothing is clicked), before/after are cart states, item is the cart line.

Kind: runs on a computer; changes state; pacing: cart.

| Argument   | Type                                  | Required | Notes                                            |
| ---------- | ------------------------------------- | -------- | ------------------------------------------------ |
| `browser`  | string (max 64 chars)                 | no       | Browser id, name or alias; see Browser selection |
| `item_id`  | string (8 to 64 chars, A-Z a-z 0-9 -) | yes      | Cart line id from get_cart                       |
| `quantity` | integer 1..999                        | yes      | The wanted quantity                              |

**Result.** `{ changed, before, after, item }`: `before` and `after` are cart states (active lines
with `item_id`, `asin`, `title`, `quantity`, `price`, the saved lines and the subtotal) and `item`
is `{ item_id, asin, title }`. When the quantity already equals the wanted one, `changed` is false,
`before` and `after` are the same and nothing is clicked.

**Errors.** `invalid_arguments` (the wanted quantity differs from the current one by more than 20,
or `item_id` is malformed), `not_found` (no such item in the active cart; the message says when it
is in Saved for later), `needs_human`, `throttled`, `layout_unrecognized`, `internal` (the cart did
not end at the wanted quantity; observed state attached), `timeout`.

**Notes.** `item_id` comes from `get_cart`. The flow reads the cart, then clicks the line's
increase or decrease control (its description must say "Increase quantity by one" or "Decrease
quantity by one") through the click guard once per unit, waiting for the line to record each
applied step, and reads the cart again. The quantity never goes below 1, because the last
decrement on the real page would delete the line; use `remove_from_cart` for that. A line whose
quantity is capped by the retailer (a per-customer limit) ends below the wanted value and fails
with `internal`.

### `remove_from_cart`

> Remove an item from the cart. Returns {changed, before, after, item}.

Kind: runs on a computer; destructive; pacing: cart.

| Argument  | Type                                  | Required | Notes                                            |
| --------- | ------------------------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars)                 | no       | Browser id, name or alias; see Browser selection |
| `item_id` | string (8 to 64 chars, A-Z a-z 0-9 -) | yes      | Cart line id from get_cart                       |

**Result.** Implemented. `{ changed: true, before, after, item }`: `before` and `after` are compact
cart states (active lines with `item_id`, `asin`, `title`, `quantity` and `price`; saved lines;
subtotal) and `item` identifies the line.

**Errors.** `invalid_arguments`, `not_found` (no such line, or it is in the other section; the
current state is attached), `blocked_by_policy`, `needs_human`, `throttled`,
`layout_unrecognized`, `internal`, `timeout`.

**Notes.** Marked destructive in the MCP annotations. The flow checks that two page loads fit the pacing budget, reads the cart,
clicks that line's own control through the click guard, waits, reads the cart again and fails with
`internal` (observed state attached) unless the line is gone from the active cart and its ASIN is not there any more. `item_id` comes from `get_cart` and is
checked against `^[A-Za-z0-9-]{8,64}$`.

### `save_for_later`

> Move a cart item to Saved for later. Returns {changed, before, after, item}.

Kind: runs on a computer; changes state; pacing: cart.

| Argument  | Type                                  | Required | Notes                                            |
| --------- | ------------------------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars)                 | no       | Browser id, name or alias; see Browser selection |
| `item_id` | string (8 to 64 chars, A-Z a-z 0-9 -) | yes      | Cart line id from get_cart                       |

**Result.** Implemented. `{ changed: true, before, after, item }`: `before` and `after` are compact
cart states (active lines with `item_id`, `asin`, `title`, `quantity` and `price`; saved lines;
subtotal) and `item` identifies the line.

**Errors.** `invalid_arguments`, `not_found` (no such line, or it is in the other section; the
current state is attached), `blocked_by_policy`, `needs_human`, `throttled`,
`layout_unrecognized`, `internal`, `timeout`.

**Notes.** Moves the line to the Saved for later section. The flow checks that two page loads fit the pacing budget, reads the cart,
clicks that line's own control through the click guard, waits, reads the cart again and fails with
`internal` (observed state attached) unless the ASIN left the active cart and is now in Saved for later. `item_id` comes from `get_cart` and is
checked against `^[A-Za-z0-9-]{8,64}$`.

### `move_to_cart`

> Move a Saved for later item back to the cart. Returns {changed, before, after, item}.

Kind: runs on a computer; changes state; pacing: cart.

| Argument  | Type                                  | Required | Notes                                            |
| --------- | ------------------------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars)                 | no       | Browser id, name or alias; see Browser selection |
| `item_id` | string (8 to 64 chars, A-Z a-z 0-9 -) | yes      | Cart line id from get_cart                       |

**Result.** Implemented. `{ changed: true, before, after, item }`: `before` and `after` are compact
cart states (active lines with `item_id`, `asin`, `title`, `quantity` and `price`; saved lines;
subtotal) and `item` identifies the line.

**Errors.** `invalid_arguments`, `not_found` (no such line, or it is in the other section; the
current state is attached), `blocked_by_policy`, `needs_human`, `throttled`,
`layout_unrecognized`, `internal`, `timeout`.

**Notes.** Moves a Saved for later line back into the cart. The flow checks that two page loads fit the pacing budget, reads the cart,
clicks that line's own control through the click guard, waits, reads the cart again and fails with
`internal` (observed state attached) unless the ASIN is in the active cart and no longer in Saved for later. `item_id` comes from `get_cart` and is
checked against `^[A-Za-z0-9-]{8,64}$`.

### `delete_saved_item`

> Delete a Saved for later item. Returns {changed, before, after, item}.

Kind: runs on a computer; destructive; pacing: cart.

| Argument  | Type                                  | Required | Notes                                            |
| --------- | ------------------------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars)                 | no       | Browser id, name or alias; see Browser selection |
| `item_id` | string (8 to 64 chars, A-Z a-z 0-9 -) | yes      | Cart line id from get_cart                       |

**Result.** Implemented. `{ changed: true, before, after, item }`: `before` and `after` are compact
cart states (active lines with `item_id`, `asin`, `title`, `quantity` and `price`; saved lines;
subtotal) and `item` identifies the line.

**Errors.** `invalid_arguments`, `not_found` (no such line, or it is in the other section; the
current state is attached), `blocked_by_policy`, `needs_human`, `throttled`,
`layout_unrecognized`, `internal`, `timeout`.

**Notes.** Marked destructive in the MCP annotations. The flow checks that two page loads fit the pacing budget, reads the cart,
clicks that line's own control through the click guard, waits, reads the cart again and fails with
`internal` (observed state attached) unless the saved line is gone. `item_id` comes from `get_cart` and is
checked against `^[A-Za-z0-9-]{8,64}$`.

## Writes: lists

### `create_list`

> Create a list (privacy defaults to private). Returns {changed, list, before, after}: the new list and
> the lists page read back before and after.

Kind: runs on a computer; changes state; pacing: list.

| Argument  | Type                          | Required | Notes                                            |
| --------- | ----------------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars)         | no       | Browser id, name or alias; see Browser selection |
| `name`    | string (min 1, max 100 chars) | yes      |                                                  |
| `privacy` | `private`, `shared`, `public` | no       | Default private                                  |

**Result.** Implemented. `{ changed: true, list, before, after }`: `list` is `{ list_id, name, privacy }`
of the new list; `before` and `after` are the lists page read back before and after, each an array
of `{ list_id, name, privacy }`.

**Errors.** `invalid_arguments` (empty name), `blocked_by_policy`, `needs_human`, `throttled`,
`layout_unrecognized`, `internal` (the new list did not appear; the observed lists are attached),
`timeout`.

**Notes.** `privacy` defaults to `private`. The flow checks that two page loads fit the `list`
budget (four when `privacy` is not private), reads the lists page, creates the list through the
site's own dialog and reads the lists page again. For a `shared` or `public` list the privacy is set afterwards, through the
manage-list dialog of the new list.

### `update_list`

> Rename a list and/or set its privacy (private, shared or public). Returns {changed, before, after}
> read back from the list page.

Kind: runs on a computer; changes state; pacing: list.

| Argument  | Type                          | Required | Notes                                            |
| --------- | ----------------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars)         | no       | Browser id, name or alias; see Browser selection |
| `list_id` | string                        | yes      | 8 to 16 characters from list_lists               |
| `name`    | string (min 1, max 100 chars) | no       |                                                  |
| `privacy` | `private`, `shared`, `public` | no       |                                                  |

**Result.** Implemented. `{ changed: true, before, after }`: `before` and `after` are
`{ list_id, name, privacy }` read from the list page.

**Errors.** `invalid_arguments` (not a list id, nothing to change, empty name), `blocked_by_policy`,
`needs_human`, `throttled`, `layout_unrecognized`, `internal` (the settings did not change as
intended; the observed state is attached), `timeout`.

**Notes.** Give a `name`, a `privacy` or both. The flow changes them through the list's manage-list
dialog and reads the list back. Changing `privacy` to `public` or `shared` exposes the list to other people; the tool
does not ask for confirmation, the model should.

### `delete_list`

> Delete a whole list with all its items; this cannot be undone. Returns {changed, before, after, list}:
> the lists page read back before and after.

Kind: runs on a computer; destructive; pacing: list.

| Argument  | Type                  | Required | Notes                                            |
| --------- | --------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars) | no       | Browser id, name or alias; see Browser selection |
| `list_id` | string                | yes      | 8 to 16 characters from list_lists               |

**Result.** Implemented. `{ changed: true, before, after, list }`: `before` and `after` are the lists
page read back before and after (arrays of `{ list_id, name, privacy }`) and `list` is
`{ list_id, name }` of the deleted list.

**Errors.** `invalid_arguments`, `not_found` (no such list; the lists are attached),
`blocked_by_policy`, `needs_human`, `throttled`, `layout_unrecognized`, `internal` (the list is
still there; the observed lists are attached), `timeout`.

**Notes.** Deletes the whole list with all its items and cannot be undone. The flow opens the
list's manage-list dialog, clicks its Delete list control and then the confirmation the site asks
for, each through the click guard. Marked destructive in the MCP annotations.

### `add_to_list`

> Add a product to a list. Returns {changed, added, before_count, after_count}, or {changed: false} when
> the product is already on the list.

Kind: runs on a computer; changes state; pacing: list.

| Argument  | Type                  | Required | Notes                                            |
| --------- | --------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars) | no       | Browser id, name or alias; see Browser selection |
| `list_id` | string                | yes      | 8 to 16 characters from list_lists               |
| `asin`    | string                | yes      | 10 characters, A-Z and 0-9                       |

**Result.** Implemented. `{ changed: true, added, before_count, after_count }`: `added` is the new
item as read back from the list (`item_id`, `asin`, `title`, `quantity_wanted`, `priority`,
`comment`). When the product is already on the list nothing is clicked and the result is
`{ changed: false, note, list }` with the compact list state.

**Errors.** `invalid_arguments`, `blocked_by_policy`, `needs_human`, `throttled`,
`layout_unrecognized`, `internal` (the product did not appear on the list; the observed list is
attached), `timeout`.

**Notes.** The flow checks that three page loads fit the `list` budget, reads the list, opens the
product page, opens the Add to List chooser and clicks that list's own row, each through the click
guard, then reads the list again.

### `remove_from_list`

> Remove an item from a list (item_id from get_list). Returns {changed, before, after, item}.

Kind: runs on a computer; destructive; pacing: list.

| Argument  | Type                                  | Required | Notes                                            |
| --------- | ------------------------------------- | -------- | ------------------------------------------------ |
| `browser` | string (max 64 chars)                 | no       | Browser id, name or alias; see Browser selection |
| `list_id` | string                                | yes      | 8 to 16 characters from list_lists               |
| `item_id` | string (6 to 64 chars, A-Z a-z 0-9 -) | yes      | List item id from get_list                       |

**Result.** Implemented. `{ changed: true, before, after, item }`: `before` and `after` are compact
list states (`list_id`, `name`, `privacy` and the items with `item_id`, `asin`, `title`,
`quantity_wanted`, `priority` and `comment`).

**Errors.** `invalid_arguments`, `not_found` (no such item on that list; the state is attached),
`blocked_by_policy`, `needs_human`, `throttled`, `layout_unrecognized`, `internal`, `timeout`.

**Notes.** `item_id` comes from `get_list` and is checked against `^[A-Za-z0-9-]{6,64}$`. The flow
checks that two page loads fit the `list` budget, reads the list, clicks that item's own Delete
control through the click guard, reads the list again and fails with `internal` if the item is
still there. Marked destructive in the MCP annotations.

### `update_list_item`

> Set quantity wanted, priority and/or comment on a list item. Returns {changed, before, after}: the item
> read back before and after.

Kind: runs on a computer; changes state; pacing: list.

| Argument          | Type                                         | Required | Notes                                            |
| ----------------- | -------------------------------------------- | -------- | ------------------------------------------------ |
| `browser`         | string (max 64 chars)                        | no       | Browser id, name or alias; see Browser selection |
| `list_id`         | string                                       | yes      | 8 to 16 characters from list_lists               |
| `item_id`         | string (6 to 64 chars, A-Z a-z 0-9 -)        | yes      | List item id from get_list                       |
| `quantity_wanted` | integer 1..999                               | no       |                                                  |
| `priority`        | `lowest`, `low`, `medium`, `high`, `highest` | no       |                                                  |
| `comment`         | string (max 500 chars)                       | no       |                                                  |

**Result.** Implemented. `{ changed: true, before, after }`: `before` and `after` are the item as read
from the list before and after (`item_id`, `asin`, `title`, `quantity_wanted`, `priority`,
`comment`).

**Errors.** `invalid_arguments` (not a list or item id, or none of the three fields given),
`not_found` (no such item on that list; the state is attached), `blocked_by_policy`, `needs_human`,
`throttled`, `layout_unrecognized`, `internal` (the item did not change as intended; the observed
item is attached), `timeout`.

**Notes.** Any of `quantity_wanted`, `priority` and `comment` may be given. The flow opens the
item's edit dialog through its own edit link, fills the fields, clicks Save and reads the list
again; every field that was given must match.

### `move_list_item`

> Move an item to another list. Returns {changed, item, source_after, destination_has_item}. Only moving
> is implemented: copy: true answers unsupported (use add_to_list for the other list instead).

Kind: runs on a computer; changes state; pacing: list.

| Argument     | Type                                  | Required | Notes                                            |
| ------------ | ------------------------------------- | -------- | ------------------------------------------------ |
| `browser`    | string (max 64 chars)                 | no       | Browser id, name or alias; see Browser selection |
| `list_id`    | string                                | yes      | 8 to 16 characters from list_lists               |
| `item_id`    | string (6 to 64 chars, A-Z a-z 0-9 -) | yes      | List item id from get_list                       |
| `to_list_id` | string                                | yes      | 8 to 16 characters from list_lists               |
| `copy`       | boolean                               | no       |                                                  |

**Result.** Implemented. `{ changed: true, item, source_after, destination_has_item }`: `item` is the
item as it was on the source list, `source_after` is the number of items left on it and
`destination_has_item` is true when the destination list shows the same product.

**Errors.** `invalid_arguments` (not list or item ids, or both lists are the same), `unsupported`
(`copy: true`), `not_found` (no such item on that list; the state is attached),
`blocked_by_policy`, `needs_human`, `throttled`, `layout_unrecognized`, `internal` (the item did
not move as intended; the observed state is attached), `timeout`.

**Notes.** Only moving is implemented: the site offers Move only, so `copy: true` is refused with
`unsupported` before any page is loaded (to copy, use `add_to_list` on the other list). The flow
checks that three page loads fit the `list` budget, clicks the item's Move control and then the
destination in the move menu, each through the click guard, and reads both lists back.

## Diagnostics

### `get_status`

> Hub state ({protocol, min_daemon_version, pending_calls}) plus the same per-computer rows as
> list_browsers (online, daemon version, cool-down, and the pacing left: pacing_burst.left page
> loads fit right now). Takes no arguments; costs no page load; does not report parser health.

Kind: answered by the Worker; read only; pacing: none.

This tool takes no arguments.

**Result.** `{ hub: { protocol, min_daemon_version, pending_calls }, browsers: [...] }` with the
same browser rows as `list_browsers`, so per computer: `daemon_version`, `online`,
`cooling_down_until` and `pacing_budget`.

**Errors.** `invalid_arguments`.

**Notes.** It always lists every computer and does not report parser health. An old client that
still sends a `browser` argument is not rejected: unknown arguments are dropped by the schema.

### `get_audit_log`

> Recent tool calls: time, client, tool, browser, outcome, duration, error code; arguments for write
> tools only. Never page content. 90-day retention.

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
