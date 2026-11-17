# Privacy

Two things are covered here: the policy that keeps real data out of this public repository (the
fixture policy, which matters to contributors), and what the running system stores and where (which
matters to people who host it).

## The fixture policy

rainforest parses real Amazon pages, so it needs realistic test pages. Real captures contain
names, addresses, order ids, card digits and purchase history. **Raw captures never enter the
repository.** What enters is a synthetic fixture: a page that keeps the structure the parsers need
and nothing that was real.

### The rules

- The repository is public and identity-free. No account id, hostname, domain, email, machine name,
  token, real name, address, ZIP, phone, order id or ASIN appears in code, docs, tests, fixtures,
  workflow files or commit messages.
- A raw capture lives only in a private directory outside the repository. Never stage one. After a
  browser session, read `git status` and stage by path; never `git add -A`.
- Product titles, review text and search queries in fixtures are invented, never copied from a
  real page.
- Fixtures live under `<fixtures root>/<kind>/<case>/`. The parser fixtures are in
  `packages/parsers/test/fixtures` (a top-level `fixtures/` directory is scanned too if it
  exists). Nothing else in the tree is scanned by the CI gate, so capture-derived files belong
  there and nowhere else. The mock storefront (`packages/mock-site`) is not capture-derived: all of
  its content is invented.

### Reserved fake ranges

Fixtures may contain these identifiers and no others. They are defined once in `FAKE` in
`packages/core/src/capture.ts` and mirrored in `packages/scrubber/src/rules.mjs` (a test keeps the
two equal).

| Kind        | Allowed form                                                                         |
| ----------- | ------------------------------------------------------------------------------------ |
| ASIN        | `B0FAKE` plus four characters from 0-9 A-Z (`X0FAKE....` for parent ASINs)           |
| Order id    | `000-0000000-NNNNNNN`                                                                |
| Email       | any address at `example.com`                                                         |
| Phone       | `555-555-01NN`                                                                       |
| ZIP         | `00000`, `00001`, `00002`, `00003`                                                   |
| Image URL   | `https://images.example.com/placeholder.png`                                         |
| Page host   | `https://www.example.com` (`www.w3.org` is also allowed, for SVG and XML namespaces) |
| Card digits | `0000`                                                                               |
| UUID        | `00000000-0000-4000-8000-` followed by 12 digits                                     |
| Other ids   | `FAKEID<digits>` and `FAKETOKEN<digits>`                                             |
| Places      | `Exampleville`, state `ZZ`, street `100 Example St`                                  |
| Names       | a fixed list of obviously fake names (for example "Alex Example")                    |

`captured_at` in every fixture is the same fixed synthetic timestamp.

### The scrubber

`packages/scrubber` turns a raw capture into a synthetic one. It is structure-preserving and
fails closed: everything not on an allowlist is replaced or dropped, so safety does not depend on
recognizing what a value is.

What it keeps:

- tags, ids, classes, `data-*` attribute names and the attribute values on a short allowlist of
  structural ones (roles, types, form structure, ARIA state, SVG geometry, and the
  `data-rf-hidden` markers);
- a list of structural UI labels (`packages/scrubber/src/labels.txt`) that parsers anchor on;
- the shape of numbers, dates, prices, ids and URL paths, so a parser still sees what it expects;
- inert JSON data blobs (`application/json` and Amazon's state scripts), with keys kept and values
  scrubbed.

What it replaces or drops:

- every other word, with invented filler words of the same shape;
- ASINs, order ids, emails, phones, ZIPs, card digits, UUIDs and opaque tokens, mapped to the fake
  ranges by order of first appearance (never derived from the real value, so nobody can confirm a
  guess by hashing it);
- dates, shifted by a secret per-capture offset so intervals survive but absolute dates do not;
- every URL, moved to the placeholder host with media replaced by the placeholder image and the
  query string cut to allowlisted parameter names;
- scripts other than inert JSON, styles, comments, event handlers, tracking pixels, iframes and
  inline styles.

The scrubber is deterministic for a given input and seed. After scrubbing it audits its own output
with the same rules the CI gate uses; if anything still looks real, it writes nothing and exits 1.

### The three gates

1. **Local private denylist (a git hook).** Hooks in `.githooks` (enabled with
   `node scripts/setup-hooks.mjs`) run `scripts/privacy-gate.mjs`: `pre-commit` scans staged files
   and their paths, `commit-msg` scans the commit message, and `pre-push` scans every commit being
   pushed (messages, paths and file contents). The denylist is a private file outside the
   repository (its path comes from `RAINFOREST_DENYLIST` or `git config rainforest.denylist`;
   plain text or `re:` regular expressions), so the list of things to keep out is itself never
   published. On the maintainer's machine a missing or empty denylist fails closed. The pre-push
   scan also requires each commit's author and committer to equal the configured identity
   (`git config rainforest.identity`); that check is not run at commit time. The gate never prints
   the matched text, only the file and line. On a contributor's machine with no denylist
   configured it skips.
2. **Public CI allowlist gate.** `scripts/check-fixtures.mjs` runs in CI for every pull request
   and push (and in `npm run check`, as `npm run fixtures:check`). It needs no secrets. It walks
   `fixtures/` and `packages/parsers/test/fixtures` and fails if:
   - any identifier is outside the fake ranges, or any URL host is not on the three allowed
     placeholder hosts, or an opaque token or long upper-case id is present;
   - a script is not an inert JSON blob, or the page has styles, links, objects, embeds,
     comments, event handlers, inline styles or iframe sources;
   - the layout is wrong (`<kind>/<case>/capture.json` and `page.html` are required, `capture.json`
     must not carry the HTML, files may only be `.html`, `.json`, `.md` or `.txt`, no symlinks);
   - a file's path itself looks like a leak.

   Its output names the file, line and rule, never the value, because CI logs are public. The
   rules live in `packages/scrubber/src/rules.mjs`, shared with the scrubber's self-audit so the
   two cannot drift.

3. **Model review of each fixture diff.** Before a fixture is committed, a model is asked to review
   the diff for anything that looks like real data (names, places, product wording that reads like
   a real listing, anything personal). This is a maintainer practice, not an automated workflow in
   this repository: nothing in CI performs it.

### Adding a fixture (contributors)

1. Capture a page from your own signed-in session with the developer capture tool
   (`packages/browser/src/dev-capture.ts`; it needs `RAINFOREST_TOKEN`,
   `RAINFOREST_EXTENSION_ID` and `RAINFOREST_CORPUS` in the environment and a tab-separated job
   file), writing into a **private directory outside the repository**. The `rainforestd capture`
   command is a placeholder that does not capture anything yet.
2. Scrub it into the fixture directory:

   ```
   node packages/scrubber/src/cli.ts <raw-capture-dir> packages/parsers/test/fixtures/<kind>/<case> --note "what this case exercises" [--seed <s>] [--reduce]
   ```

   The command prints counts per replacement category (never values). If it reports findings it
   writes nothing; do not hand-edit around a finding, change the capture or the rules.

3. Write `expected.json` for the case from the parser and review it. Name the case for what it
   exercises (for example "no featured offer"), not for what the page was.
4. Run `npm run fixtures:check`, then `npm run check`.
5. Read the whole diff yourself, with the third gate in mind. If a value could identify a real
   person, product listing or place, remove it.
6. Commit with a Conventional Commit message that contains no personal data, and open a pull
   request. If anything real slipped into a commit, tell the maintainers instead of merging: history
   has to be rewritten, not just the file.

Deleting a leaked file in a later commit does not remove it from history.

## What the system stores

### The hub (Cloudflare Worker)

| Where                     | What                                                                                                                                             | How long                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Durable Object, devices   | device id, name, aliases, OS, public key, created and revoked time, last seen and last presence                                                  | until you delete the object                                                          |
| Durable Object, pairings  | device id, code, name, OS, public key, status                                                                                                    | rows older than a day after expiry are deleted                                       |
| Durable Object, selection | which device each connected client chose                                                                                                         | until cleared or the device is revoked                                               |
| Durable Object, audit     | per call: time, client name, tool, device, outcome, duration, error code; arguments for write tools (and `select_browser`) up to 4000 characters | 90 days                                                                              |
| Durable Object, calls     | the in-flight call: tool, client, write arguments, and the result JSON once the computer answers                                                 | until the waiting request collects it; swept 30 seconds after the deadline otherwise |
| Durable Object, lockout   | timestamps of wrong app-password attempts                                                                                                        | 15 minutes                                                                           |
| KV namespace              | OAuth clients, grants and token records, managed by the OAuth library (the admin page lists the grants and can revoke them)                      | token lifetimes (one hour access, one year refresh), or until a grant is revoked     |
| Worker secrets            | the five required settings (including the hash of the app password) and the optional minimum daemon version                                      | until you change them                                                                |

The hub does not store page content in any lasting way. Results do pass through the Durable
Object's storage in the `calls` table while a request waits for them, and a hub operator (you)
could read them there during that window. Worker request logs are enabled in `wrangler.jsonc`
(`observability`); the code does not write page content or tool arguments to the console.

Cloudflare Access, which you configure, keeps its own record of who signed in to `/authorize` and
`/admin`.

### The computer (daemon)

All of it lives in the app directory (see docs/ARCHITECTURE.md for paths):

| File                                 | What                                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `config.json`                        | hub URL, device id and name, aliases, Chrome profile name, extension id, broker mode and port, update repository and interval |
| `device-key.json`                    | the device's Ed25519 key pair (owner-only)                                                                                    |
| `secrets.json`                       | the extension token, and the update token if you add one (owner-only)                                                         |
| `pacing.json`                        | timestamps of recent page loads per page type, and any active cool-down (owner-only)                                          |
| `audit.jsonl`                        | per call: time, tool, outcome, duration, error code; arguments for write tools only                                           |
| `logs/`                              | operational JSON lines with secrets dropped by key name                                                                       |
| `state.json`, `versions/`, `current` | installed versions and update bookkeeping                                                                                     |

The daemon holds page content in memory only while handling a call and for three small caches:
the cursor cache (up to 40 parsed results for 15 minutes), the recent page captures that several
product tools share (two minutes, dropped after any write) and the price-history cache (six hours
per source and ASIN). The key that seals cart offer ids also lives only in memory, so offer ids die
with the process. It does not write captures to disk in normal operation; the developer capture
tool is a separate, opt-in program.

The daemon reads a little about the machine and sends it to the hub as presence: seconds since last
keyboard or mouse input, whether the screen is locked, whether Chrome is running, whether the
extension is connected, whether an Amazon page was read successfully, any cool-down end time, and
the daemon version, the names you gave the computer with `setup --alias` and the remaining
pacing budget per page type. The hub uses it to choose a computer and to show you
`list_browsers`. On macOS
this uses `ioreg` and `pgrep`; on Windows it uses `tasklist` and one short internal PowerShell
helper.

### What leaves your machine

The tool results go to the Worker and then to the Claude client you connected, which is the point of
the tool. Update checks go to GitHub's API for the repository you configured. A price-history lookup
loads a CamelCamelCamel page in your browser; for Keepa the daemon only builds a chart URL and
returns it, and never loads a Keepa page itself. `show_on_screen` opens an amazon.com page in a
normal tab of your own browser. Nothing is sent to any other party by this code.
