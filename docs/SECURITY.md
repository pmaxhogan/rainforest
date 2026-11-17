# Security

This document describes what rainforest protects, against whom, and where it does not. It is
derived from the code. It has not been independently audited, and it makes no promise that a
recent Amazon change cannot defeat the URL policy: the policy is a set of patterns written by hand.

## What is being protected

A connected client can read your Amazon account pages (orders with the shipping address and card
brand and last four digits shown on them, invoices, subscriptions, lists, browsing history, cart)
and change your cart (add an offer, remove, save for later, move back, delete a saved item) and
remove items from your lists. The goal is that the worst a client,
a stolen token, a compromised hub or a hostile web page can do is limited to that. In particular,
nothing in the system is meant to be able to spend money, change an address or payment method,
change account settings or sign in as you somewhere else.

## Threat model

### Who can get a token

An OAuth access token for `/mcp` is minted only after two independent checks on `/authorize`, and
both must pass in the same request:

1. **Cloudflare Access.** The Worker verifies the Access JWT itself, not just that a header is
   present: RS256 signature against the team's published keys (cached for an hour, refetched at
   most once a minute when an unknown key id appears), audience, issuer, expiry, not-before, and
   that the email equals the configured owner. Any failure is a refusal. The Access application is
   expected to cover only `/authorize` and `/admin`, with an owner-only policy.
2. **The app password.** A machine-generated secret (at least 22 characters; the guidance is 128
   bits or more of entropy) typed on the consent page. Only its SHA-256 is stored, as a Worker
   secret, and the comparison is constant time. Five wrong attempts across the whole Worker in 15
   minutes lock the form for everyone, and there is a per-IP rate limit on top. A correct password
   clears the count.

The consent page names the client and where it will send access. The authorization request stays
on the server; the form carries a single-use handle bound to the browser by a cookie. Dynamic
client registration is open, so any client can ask for consent; it still cannot get a token
without the two checks above.

There is no static bearer token and no bypass. When the owner configuration is missing, the Worker
refuses everything except `/healthz` (it fails closed).

What a token holder can do: call every tool until the token expires (an hour; refresh tokens last a
year). The tools are the ones in docs/TOOLS.md: no tool places an order. The `/admin` page lists
the connected clients (the OAuth grants) and has a Disconnect button for each, which revokes that
grant; revoking a device instead stops all browser work on that computer. Clearing the Worker's
`OAUTH_KV` namespace in the Cloudflare dashboard remains the blunt option (unverified as a
procedure).

### What a compromised hub could and could not do

"The hub" means the Worker and its Durable Object, or whoever controls your Cloudflare account.
Because every page parse and every rail runs on your computer, a hostile hub is limited, but not
harmless.

It could:

- see tool arguments and results in transit (the hub relays everything), and the audit log;
- send calls for any tool in the registry with schema-valid arguments, to any paired computer, and
  have them run, within the daemon's pacing budget. That includes the write tools, but
  `add_to_cart` needs an offer id that only the daemon process holds the key for (the hub cannot
  mint one), and every write acts on one named cart line or list item behind the click guard;
- return false results to the client, or omit the untrusted-content wrapper (the Worker applies
  it, so the wrapper protects against a hostile page, not a hostile hub);
- refuse service, or tell daemons to check for updates.

It could not:

- make the daemon navigate anywhere the URL policy refuses: typed flows build their own URLs from
  validated arguments, there is no "go to this URL" tool, and the network guard checks every
  request of the automation tab;
- reach checkout, payment, address or account-settings pages, or place an order;
- run code on your computer. The only way new code arrives is a release whose manifest signature
  verifies against public keys embedded in the running build, and the hub does not hold those
  keys. The hub can send `update_hint` and a minimum version, but that only starts a check of the
  configured GitHub repository;
- roll the daemon back: only strictly newer versions are accepted;
- impersonate a device (it never has the device's private key) or get the key: pairing registers
  only the public half;
- make the daemon accept an oversized or malformed frame: frames are size-capped and schema
  checked, and calls are accepted only on an authenticated connection.

The daemon authenticates the hub only through TLS to the hub URL in its config (which must be
https). If someone controls that hostname's certificate, they are the hub.

### Pairing and device keys

`rainforestd pair` creates an Ed25519 key pair once, stores it owner-only (mode 0600 on macOS; an
`icacls` grant to the current user only on Windows) and sends only the public key to
`/pair/start`, with a device name and OS. The hub answers with a device id and an 8 character code
from an alphabet without look-alike characters, valid for 10 minutes. At most 5 pairings may be
pending, and one per key.

Nothing is trusted until you approve: you open `/admin` (behind Access), check that the code and
device name match what the daemon printed, and press Approve. The page also shows a short
fingerprint of the device's public key. The daemon proves it holds the key while it waits, by
signing a timestamped request to `/pair/status` (accepted within five minutes of the hub's
clock). After approval, every connection authenticates with a fresh
single-use nonce and a signature over the nonce, device id and protocol version. Revoking a device
on `/admin` closes its socket at once and removes it from selection. The pairing code is the human
check: approve only a code that a daemon printed on a computer in front of you.

### What a hostile page could do

Amazon pages are untrusted input: a seller can put text in a title, a review or a description
that tries to instruct the model, and a page can serve any markup at all. The layers, outermost
first:

1. **The untrusted wrapper.** Every result is introduced by a fixed notice and enclosed in a tag
   with a per-call random id, so page text cannot close it. This reduces the chance that a model
   follows injected text. It does not guarantee it; models can still be fooled.
2. **Typed flows only.** A page cannot make the daemon do anything: the daemon runs fixed flows
   that read and parse, and click specific controls. There is no tool that executes page-supplied
   selectors, scripts or URLs.
3. **The URL policy** (below), enforced at the network layer of the automation tab, so even a page
   that navigates, posts a form or runs script cannot reach a refused URL.
4. **Click guard** (below). Every click a write flow makes goes through one function that refuses
   anything that is not the specific control the flow expects, or that looks like a purchase.
5. **Limits on blast radius.** Even a fully successful injection can only invoke the tools of the
   registry, at the pacing rate (per computer), with their schema limits, through the signed-in
   session. The realistic worst cases are reading more of your account than you intended and
   editing the cart or lists. It cannot buy.

The page content the model reads is also sent to the connected client (claude.ai or Claude Code).
That is the purpose of the tool; treat the connector as having read access to your order history.

## The URL policy

Source: `packages/browser/src/policy.ts` (read it; the patterns are the specification). It is a
pure function over a request and fails closed: an unparseable URL, a missing field or an unknown
host is a denial. Three checks on requests, plus a separate guard for clicks:

1. **Hard deny, for every request.** On `amazon.com` and its subdomains, for every resource type
   (documents, XHR, fetches, form posts, subframes), a request is refused if its path matches the
   deny list. The categories:
   - checkout and buy flows (including the cart's proceed-to-checkout paths, Prime sign-up
     pipelines, Subscribe & Save creation);
   - one-click, buy-now, turbo checkout, and digital and video purchase endpoints;
   - sign-in and the authentication portal;
   - address books and delivery-address changes;
   - payment methods, wallet, gift-card redemption and the payments pages;
   - account settings, login and security, profile and membership management;
   - order editing and cancellation (any path containing "cancel");
   - return initiation.

   A buy marker anywhere in the query string is refused regardless of method. A non-GET request to
   a cart-like path must have a readable body, and a body containing a buy marker is refused; an
   unreadable body is refused too. Telemetry and suggestion hosts (a short fixed list) are exempt
   from the path rules because their paths are opaque blobs, and carry nothing that can change an
   order.

2. **Main-frame allowlist.** A top-level document must additionally match a positive allowlist:
   the home page, search, product pages, all-offers, reviews, cart, orders and order details, the
   invoice print view, package tracking, lists, Subscribe & Save, browsing history, and three
   exact third-party URL shapes for price history (CamelCamelCamel product and chart pages, Keepa
   graph images). Only GET. Anything else is refused, which is why a redirect to an unexpected page
   fails.
3. **Fragment allowlist.** Same-origin documents fetched from inside a loaded page (not
   navigations) must pass the hard-deny layer and match a short fragment list, currently the
   all-offers document.
4. **Purchase-control patterns (for clicks).** `isPurchaseControl` (used by the click guard,
   below) refuses to treat a control as
   safe when its text, id, name, aria label or value matches a list of purchase-like wording: buy
   now, place order, proceed to checkout, 1-click or turbo, pay now, use this payment or address,
   subscribe now or set up now, start a trial or membership, join or try Prime, confirm a purchase,
   order or subscription, cancel items, order or subscription, return or replace, pre-order or
   rent now. It also refuses a control whose link or form action the URL policy would deny, and
   fails closed on missing input.

Non-HTTPS main-frame documents are refused except `about:blank`; non-HTTPS sub-resources are
refused except `data:`, `blob:` and extension URLs.

Tests pin these lists to hardcoded expectations (not by iterating the live export), so a pattern
cannot be removed or loosened without a test change.

### The network guard and redirects

Playwright's request interception does not see redirect hops. So the guard installs a listener on
the page's raw Chrome DevTools session, ahead of Playwright's own handler, for every paused
request, and a catch-all route keeps interception enabled. For each request, including every hop
of a redirect chain, the listener runs the policy and, on a denial, fails the request at the Fetch
level (`Fetch.failRequest`) before it leaves the browser. The request body is read where Chrome
exposes it. Blocks are logged (reason, rule, host and a truncated path) at debug level.

Two more properties keep it from being bypassed:

- **Service workers are bypassed** for the automation tab. A site's service worker can otherwise
  fetch top-level pages itself, outside page-level interception, and the guard would never see
  those navigations.
- **It fails closed when it saw nothing.** The guard counts the main-frame documents it inspected.
  If a navigation finished without the guard having seen a main-frame document, nothing after it
  can be trusted: the tab goes to `about:blank`, the browser session is closed and the call fails
  with `internal`.

The guard covers the automation tab. It does not cover tabs you open yourself in the same profile
(including the tab `show_on_screen` opens for you).

### The navigation guard

A third layer watches the tab itself. A `framenavigated` listener on the page checks every
main-frame URL the tab commits, whatever caused it (a click, a script, a redirect). If the URL is
one the policy refuses, the tab is sent to `about:blank` immediately, the session is marked
violated and the call fails with `blocked_by_policy` (`details.landed` holds the path, without the
query string). After every navigation the flow also checks the URL the tab ended on. A refused
main-frame redirect sends the tab to `about:blank` and returns `blocked_by_policy`
(`details.refused_path` and `from_path` name the paths), or `needs_human` when Amazon bounced to
sign-in or a challenge page. Tabs the automation page opens by itself are closed at once.

### The click guard

`packages/daemon/src/flows/click-guard.ts` is the only way a write flow clicks. Before every click
it requires that:

1. the tab is currently on an allowlisted page (the main-frame check of the URL policy);
2. the locator matches exactly one element, and that element is the specific control the flow
   expects: its `name`, `id` or label must match the pattern the flow gave (a flow that names none
   is refused);
3. the element is not a credential field (password or email input) and does not look like a
   purchase control (`isPurchaseControl`: its text, id, name, aria label and value against the
   purchase wording above, and its link or form action against the URL policy).

Any doubt is a refusal (`blocked_by_policy`, or `layout_unrecognized` when the control is not
found exactly once); the click does not happen. The element is described by a real function run in
the page, so the check sees the real element. Flows never retry a click, and they read the cart or
list back afterwards to prove the change.

### Friction: sign-in, captcha and checkpoint pages

The daemon never solves a captcha, never types credentials and never tries to get past a
checkpoint. Pages that mean "prove you are a person" are recognized in three places: by URL (a
captcha validation path, a checkpoint or challenge path, the sign-in portal, including on a
redirect hop the guard refused), by the content classifier after capture, and by a landed URL the
policy refuses as sign-in. The call stops with `needs_human` (`kind`: `captcha`, `sign_in`,
`soft_challenge` or `interstitial`) and the computer starts a 60 minute cool-down. While it lasts,
nothing attaches or loads: every call, from every client, fails with `throttled` and
`retry_after_s`. A person has to resolve the page in that Chrome. An Amazon throttle page starts a
10 minute cool-down and returns `throttled`.

Pacing is per computer, and Amazon counts the account. An account driven from two computers gets
the sum of both budgets, which is why the per-computer caps are conservative (docs/TOOLS.md).

## Updates

A release is accepted only if all of these hold, checked in this order (code in
`packages/daemon/src/updater/`):

1. The manifest is at most 4 KiB and its Ed25519 signature verifies against a public key embedded
   in the running daemon build. Verification happens before the manifest is parsed.
2. The manifest has the expected shape, and the tarball name matches its version.
3. The version is strictly newer than the running one (downgrades and replays are refused), is not
   on this computer's list of bad versions, and the installed Node is at least the manifest's
   minimum.
4. The tarball is at most the declared size, matches the manifest's size and SHA-256, and is a
   valid archive of regular files only: no links or special entries, no absolute or `..` paths, no
   duplicate names, a single expected top-level directory, and the required files present. Asset
   downloads are only taken from the GitHub API host.
5. The new build's own `selftest` passes from the staging directory.

Only then does the pointer switch. After the restart, the new version must reach the hub within 60
seconds; if it does not, the previous version is restored and the new one is marked bad. If it
cannot start at all, the launcher restores the previous version after three unconfirmed starts.
The key list is an array, so a key can rotate: add the new key, release, then drop the old one.

Signing happens in CI in a separate job from the build: the build job installs dependencies with a
read-only token and no secrets; the signing job holds the key but installs nothing.

Anyone who forks the project and wants updates must generate their own key pair
(`scripts/release-keygen.mjs`), commit the public half to
`packages/daemon/src/updater/release-key.ts`, and store the private half only as the
`RELEASE_SIGNING_KEY` Actions secret. A daemon built from your fork trusts only your key.

## Loopback surfaces

- **Embedded broker.** The daemon's own broker binds `127.0.0.1` only, accepts a WebSocket upgrade
  only on `/ext` and only from an allowlisted `chrome-extension://<id>` origin, has no HTTP
  endpoints at all (everything else gets a 404 or a dropped socket), caps messages at 64 KiB, and
  drops clients that stop answering pings. Tokens are never sent over it to anything but the
  extension, and are handed to the local setup command only in process.
- **External broker.** In `external` mode the daemon trusts a broker some other process owns. The
  daemon's client reads the connected extensions' tokens from that broker's status document, so
  the broker's hardening is that process's responsibility. Prefer `embedded`.
- **What the origin check is.** The origin allowlist stops web pages and other extensions from
  talking to the broker, because browsers set that header and pages cannot forge it. A different
  program running as your user can write any header it likes, but it would also be able to read
  `secrets.json`, so it is inside the trust boundary anyway.
- **The device key and token files** are owner-only (0600; `icacls` on Windows). Logs and the local
  audit log drop any field whose name looks like a token, secret, password, signature,
  authorization or cookie.

The daemon opens no inbound network port: the connection to the hub is outbound.

## Admin page

`/admin` is behind Access and re-verifies the JWT in the Worker. State-changing actions are POSTs
with a double-submit CSRF token in a `__Host-` cookie plus a same-origin check. All output is
escaped, and pages carry a strict Content-Security-Policy (`default-src 'none'`, forms to self
only, no framing), `no-store` caching and no referrer.

## Audit log

The hub writes one row per tool call, including calls refused before they reach a computer:
time, client name, tool, device, outcome, duration, error code. Arguments are recorded for write
tools only (plus `select_browser`), truncated to 4000 characters. Page content is never recorded.
Rows are deleted after 90 days. The daemon keeps its own local log with the same shape (arguments
for write tools only, sensitive keys dropped) and the same retention. Read it with `get_audit_log`
or on `/admin`.

## Known limitations and residual risks

- **The debugging banner.** While the extension is attached, Chrome shows its "started debugging
  this browser" banner in that window. That is Chrome telling you that an extension holds the
  debugger on a tab. It is expected, and the quiet fork does not remove it.
- **Write flows depend on page markup.** A write flow finds its control by `name`, `id` or label
  and checks the outcome by reading the page back. If Amazon changes the markup the flow fails
  (`layout_unrecognized` or `internal`) rather than clicking something else, but a change that
  keeps the same control names and changes what they do would not be noticed beforehand.
- **A debugger-based extension is powerful.** The extension has Chrome's `debugger` capability and
  runs inside the profile that holds your Amazon session. You are trusting that extension's code
  (the fork's source is in a separate repository, and you install it from the Chrome Web Store).
  The rails in this repository constrain what the daemon asks of it, not what the extension could
  do if it were malicious or compromised.
- **Local malware is out of scope.** Anything that runs as your user can read the device key and
  the extension token. The key lets it authenticate as your device; the token lets it drive your
  signed-in tab through the broker.
- **The URL policy is hand-written.** Amazon can add a checkout path that no pattern matches. The
  two-layer design limits the damage (a new path must also be on the main-frame allowlist to be
  navigated to, and purchase controls are guarded separately), but it is not a proof.
- **Prompt injection is mitigated, not solved.** See "What a hostile page could do".
- **Results touch the hub.** Tool results and write arguments pass through the Durable Object's
  storage until collected. A compromised hub sees them. See docs/PRIVACY.md.
- **Third-party price-history sites.** CamelCamelCamel and Keepa have their own terms of service,
  which may forbid automated access. The tool is rate limited hard (6 per hour, 30 per day per
  computer) but it is your
  responsibility to decide whether to use it.
- **Amazon's terms.** Automating a retail account may be against Amazon's conditions of use, and
  Amazon may challenge or lock an account that behaves unusually. The conservative pacing is a
  mitigation, not permission.
- **Windows autostart.** The hidden-window launch of the Scheduled Task is marked unverified in the
  source; a console window may flash. On Windows the daemon also runs a short internal PowerShell
  helper to read idle time.
- **Release signing key.** The repository's embedded public key matches whatever key the
  maintainer signs releases with. If you do not trust upstream's releases, build and sign your own.

## Reporting a vulnerability

Please report vulnerabilities privately, using GitHub's private vulnerability reporting on the
repository (`pmaxhogan/rainforest`): open the Security tab and choose "Report a vulnerability".
Do not open a public issue for something exploitable. There is no email address for reports.
