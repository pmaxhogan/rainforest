# Setup

Self-hosting rainforest end to end: deploy the Worker, install the daemon on each computer you want
to use, and connect Claude. Placeholders in angle brackets (`<your-hostname>`) are yours to fill in.

Commands are marked **(unverified)** when they could not be checked against this repository's code
or the tool's own `--help`: Cloudflare dashboard labels, Claude client menus, and anything that
needs a real account. Read docs/SECURITY.md first; this gives a connected client read access to
your Amazon account.

## What you need

- A computer (macOS or Windows) per browser you want Claude to use, each with:
  - Node 22 or newer. The daemon runs TypeScript sources directly when installed from a checkout,
    which needs a Node that strips types by default (22.18 or newer; older 22.x releases may need
    a flag, unverified). The daemon's own `selftest` only enforces major version 22 or newer.
  - Google Chrome, with the **Playwright Extension (quiet)** installed in the Chrome profile that
    is signed in to Amazon. It is a fork of Playwright's extension that opens automation tabs in
    an unfocused window: source
    [pmaxhogan/playwright-extension-quiet](https://github.com/pmaxhogan/playwright-extension-quiet),
    Chrome Web Store id `djphaomahfdjobipmjingddpnnihknnk`.
- A Cloudflare account with a DNS zone you control (the Worker is served from a hostname on it)
  and Zero Trust enabled (Cloudflare Access).
- git and npm, to get this repository and Wrangler (it is a dev dependency of the Worker).
- Optional but needed for automatic updates: a GitHub repository that publishes signed releases of
  the daemon (your fork; see "Updates").

```
git clone https://github.com/pmaxhogan/rainforest.git
cd rainforest
npm ci
```

## 1. Create the app password

The consent page asks for a password in addition to your Cloudflare Access login. Generate a long
random one and its SHA-256. This one-liner works the same in macOS Terminal and Windows Command
Prompt (it needs only Node):

```
node -e "const c=require('node:crypto');const p=c.randomBytes(24).toString('base64url');console.log('app password: '+p);console.log('sha256:       '+c.createHash('sha256').update(p).digest('hex'))"
```

Save the password in a password manager; you will type it each time you connect a client. The
Worker stores only the hash. Any password of at least 22 characters is accepted, but only a
machine-generated one with 128 bits or more of entropy is appropriate: the hash is a plain SHA-256,
so the password must not be guessable.

## 2. Create the Access application (before the first deploy)

Create the Access application first, so `/authorize` and `/admin` are never reachable without it.
In the Cloudflare dashboard, Zero Trust, Access, Applications, add a self-hosted application
**(unverified: labels change)**:

- Destinations: `<your-hostname>` with path `/authorize`, and `<your-hostname>` with path
  `/admin`. **Only these two paths.** Do not put Access in front of `/mcp`, `/oauth/*`,
  `/.well-known/*`, `/devices/ws`, `/pair/*` or `/healthz`: Claude's servers and your computers
  must reach those without an interactive login, and they have their own authentication.
- Policy: one Allow rule that includes only your own email address, with an identity method that
  proves it (for example one-time PIN or your identity provider).

Write down two values from the application: its **Application Audience (AUD) tag** (a long hex
string) and your **team domain** (`<team>.cloudflareaccess.com`). The Worker verifies the Access
token itself, with both values and your email, so a mis-scoped Access rule alone cannot open the
consent page.

## 3. Deploy the Worker

From `packages/worker`. Make sure Wrangler is pointed at the Cloudflare account that owns your
zone: log in to the right account, or set `CLOUDFLARE_ACCOUNT_ID` and an API token for it
explicitly. A shell that exports credentials for another account will deploy to the wrong place.

```
cd packages/worker
npx wrangler login
npx wrangler deploy --domain <your-hostname>
```

From the repository root, `npm run deploy:hub` runs the same deploy with the hostname taken from
the `HUB_DOMAIN` environment variable (`wrangler deploy --config packages/worker/wrangler.jsonc
--domain "$HUB_DOMAIN"`).

**Deploying on every push.** Instead of deploying by hand each time, connect the Worker to your
repository with Cloudflare Workers Builds (the Worker's Settings > Builds); every push to the
production branch then runs the checks and deploys the hub. This project's own hub runs with
these build settings:

| Setting               | Value                                            |
| --------------------- | ------------------------------------------------ |
| Production branch     | `main`                                           |
| Build command         | `npm run check`                                  |
| Deploy command        | `npm run deploy:hub`                             |
| Root directory        | `/`                                              |
| Build watch paths     | include `*`; exclude `node_modules/**`, `.git/`  |
| Variables and secrets | `HUB_DOMAIN` (your hostname), stored as a secret |

The build command is the gate: the deploy command runs only after `npm run check` passes, so a
commit that fails the checks is not deployed. `HUB_DOMAIN` is a build secret, which keeps the
hostname out of the build logs; it is not one of the Worker's runtime secrets below, and it never
goes in the repository. Workers Builds reports each deploy on the commit as a check named
`Workers Builds: rainforest-hub`, next to the release workflow's checks, so one push ships both
the hub and the daemon.

`wrangler.jsonc` deliberately holds no account id, route or hostname. `--domain` attaches the Worker
as a custom domain on your zone (checked with `wrangler deploy --help`; the zone must be in the same
account). The `OAUTH_KV` namespace has no id in the config; current Wrangler provisions it on first
deploy **(unverified here: I could not run a real deploy)**. The Durable Object class `Hub` is
created by the migration in the config. The Worker has no `workers.dev` URL and no preview URLs.

Until the secrets below exist, the Worker answers 503 to everything except `/healthz`.

### The Worker secrets

Set each with `npx wrangler secret put <NAME>` and paste the value at the prompt (the command
exists; checked with `wrangler secret --help`). Run it from `packages/worker`.

| Secret                | Value                                                                |
| --------------------- | -------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`     | `https://<your-hostname>`: no trailing slash, no path, no port       |
| `ACCESS_TEAM_DOMAIN`  | `<team>.cloudflareaccess.com`                                        |
| `ACCESS_AUD`          | the Access application's AUD tag (32 to 128 hex characters)          |
| `OWNER_EMAIL`         | the one email allowed to authorize clients and use `/admin`          |
| `APP_PASSWORD_SHA256` | the 64 character lowercase hex SHA-256 from step 1                   |
| `MIN_DAEMON_VERSION`  | optional: daemons older than this are told to update and are refused |

The first five are required: if any is missing or malformed, the Worker stays closed. Check:

```
curl https://<your-hostname>/healthz
```

You should see `"configured":true`. (`"configured":false` means a secret is missing or does not
match its format.)

## 4. Install the daemon on each computer

The daemon (`rainforestd`) is not on your PATH; you run it through Node. There are two ways to get
the code, and the commands are the same either way:

- **From a checkout** of this repository (what the steps below use):

  ```
  node packages/daemon/src/main.ts <command>
  ```

- **From an unpacked release**, see "Installing a release instead" below:

  ```
  node rainforestd.mjs <command>
  ```

`node packages/daemon/src/main.ts --help` lists the commands: `install`, `uninstall`, `setup`,
`pair`, `status`, `doctor`, `capture`, `update`, `selftest`, `run` and `version`. Substitute the
path to your checkout. On Windows use backslashes in paths (or run the same commands from Git
Bash).

Do these in order, on the computer itself.

### 4a. Setup

```
node packages/daemon/src/main.ts setup \
  --hub-url https://<your-hostname> \
  --profile "Default" \
  --extension-id djphaomahfdjobipmjingddpnnihknnk \
  --repo <your-github-owner>/<your-fork-name> \
  --device-name "<a name you will recognize>"
```

On Windows Command Prompt, put it on one line (no backslashes).

Flags:

- `--hub-url` (required): `https://<your-hostname>`; must be https.
- `--profile` (required): the Chrome profile directory name, such as `Default` or `Profile 2` (the
  last segment of "Profile Path" on `chrome://version`).
- `--extension-id` (required): the id of the installed extension (the fork's Web Store id above).
- `--repo` (required): `owner/name` of the GitHub repository whose releases the daemon follows:
  your fork, or `pmaxhogan/rainforest` to follow upstream (only useful if upstream publishes signed
  releases, which is not guaranteed). It is required even if you will turn updates off.
- `--device-name`: the name shown on `/admin` and in `list_browsers` (default: the host name). The
  hub learns it when you pair, so set it before `pair`.
- `--alias` (repeatable): extra names for this computer, stored in `config.json`. The daemon
  reports them to the hub with its presence, so they work as `browser` values (and show in
  `list_browsers`) once it has connected.
- `--user-data-dir`, `--executable-path`: a non-default Chrome data directory or binary.
- `--broker-mode` (`embedded` or `external`) and `--broker-port`: see Broker modes below. The
  defaults are `embedded` and 47117.
- `--non-interactive`: accepted, but `setup` never prompts.

Missing required flags exit with code 2 and say which. Re-running `setup` keeps existing values you
do not pass. It writes `config.json` in the app directory (macOS:
`~/Library/Application Support/rainforest`; Windows: `%LOCALAPPDATA%\rainforest`; override with
`RAINFOREST_HOME`), then obtains the extension's token:

- In `embedded` mode it starts a temporary broker on the port itself. If the port is in use (an
  installed daemon is running), stop the daemon first.
- If the extension is not connected, it starts Chrome with that profile (quietly: macOS
  `open -g -j`, Windows `start /min`) and then opens the extension's `manage.html` page once to read
  the token, which may bring the browser to the front for a moment. It waits up to about 90 seconds.
- It stores the token in `secrets.json` (owner-only) and prints `next: rainforestd pair`.

**Broker modes.** `embedded` (the default `setup` writes) means the daemon itself listens on
`127.0.0.1:<port>` for the extension. Use it unless you already run a compatible broker that the
extension must share. `external` means some other process already owns the port and speaks HTTP
`/status` and `/open`; the daemon only talks to it and never restarts it (you can set
`broker.start_command` in `config.json` to launch it when the port is free). External mode relies
on that process's hardening (docs/SECURITY.md). The port the extension connects to is whatever
the extension is configured for; the code's default is 47117, and changing it needs the extension
to match **(unverified)**.

### 4b. Pair

```
node packages/daemon/src/main.ts pair
```

It creates the device key (once; it is never overwritten), sends only the public key to your hub,
and prints an 8 character code and `Device name`. Open `https://<your-hostname>/admin` (sign in
through Access), check that the pending pairing shows the same name and key fingerprint, type
the code the daemon printed into the approval box, and press **Approve**. The page does not show
codes: anyone can request a pairing, and only the person at the computer knows its code. The daemon is waiting (up to 10 minutes) and then writes the new device id into
`config.json`. If it says "the hub refused the pairing", the reason is in the parentheses (for
example a pairing for this key is already pending, or too many are pending). The `--code` flag is
accepted but not used.

### 4c. Install and start

```
node packages/daemon/src/main.ts install --link-dev
```

This copies the stable launcher into the app directory, points the `current` version at your
checkout (`--link-dev`), and registers autostart: a LaunchAgent labeled `dev.rainforest.daemon` in
`~/Library/LaunchAgents` on macOS (runs at login, kept alive), or a per-user Scheduled Task named
`rainforest-daemon` on Windows (runs at logon, restarts on failure, started through
`conhost.exe --headless` to avoid a console window, which is unverified on real Windows; the
launcher also keeps the daemon as a child process and starts it again after a self-update). It starts
the service immediately unless you pass `--no-start`.

Confirm it connected:

```
node packages/daemon/src/main.ts status
```

and look for the device with `Online: yes` on `/admin`, or call `list_browsers` from Claude.

**A source install follows releases.** The daemon from a checkout reports the version in
`packages/daemon/package.json` (0.0.0), so any signed release newer than that, from the repository
you gave with `--repo`, will replace the linked checkout. If you want to stay on your checkout, set
`"update": { "enabled": false }` in `config.json` (the file keeps unknown keys; unverified) and
restart.

**Installing a release instead.** A release is the bundled daemon, which needs no checkout and no
`npm ci` on that computer. Download `rainforestd-<version>.tgz`, `manifest.json` and
`manifest.sig` from the repository's latest release into one folder (a private repository needs
you to be signed in; the daemon's own updater uses `update_token` in `secrets.json` for that), and
check them from a checkout of this repository:

```
node scripts/verify-release.mjs <folder>
```

It checks the manifest signature against the public keys committed in
`packages/daemon/src/updater/release-key.ts` (add `--no-signature` for a fork that has no signing
key), then the tarball's size and hash and its layout. Then unpack the tarball and use the bundle
in it for every command in this step:

```
tar -xzf rainforestd-<version>.tgz
cd rainforestd-<version>
node rainforestd.mjs setup ...      # same flags as 4a
node rainforestd.mjs pair
node rainforestd.mjs install
```

Run from an unpacked release, `install` copies that release into `versions/<version>/` of the app
directory, makes it the current version unless a newer one is already active, drops the stable
launcher (`launcher.mjs`) and registers autostart, so you can delete the unpacked folder
afterwards. From then on the daemon updates itself from newer signed releases. That the bundle
starts on macOS, Windows and Linux is covered by the `daemon-smoke` workflow (it extracts a
tarball and runs `version` and `selftest`); the rest of this path, including registering autostart
from a release, follows from reading the code and is **unverified** end to end.

### 4d. Pacing caps for one computer (optional)

The daemon paces itself with deliberately low caps (docs/TOOLS.md, "Pacing classes"): by default 6
page loads in any 10 minutes and 15 per hour, per computer. They are low because Amazon counts the
account, and an account driven from two computers gets the sum of both. If one computer does all
the work and the defaults make ordinary tasks wait (one search plus one cart add is already 7
loads), raise the caps on that computer only by adding a `pacing` object to its `config.json`:

```
"pacing": {
  "burst": { "loads": 12 },
  "all": { "per_hour": 30 }
}
```

- `burst.loads`: page loads allowed in any 10 minutes, across all page types (default 6, at most
  20).
- `all.per_hour`, `all.per_day`: caps across all page types (defaults 15 and 200, at most 40 and
  400).
- A page type name (`search`, `product`, `offers`, `reviews`, `account`, `cart`, `list`,
  `price_history`) with `per_hour` and `per_day`: that type's own caps (defaults in docs/TOOLS.md,
  same ceilings).

Anything left out keeps its default. The gap of 5 to 11 seconds between loads, the 10 minute
window and the cool-downs cannot be changed. The object is validated strictly: an unknown key, a
value above a ceiling or a value that is not a whole number of at least 1 makes the config
invalid, and the daemon will not start with it (`status` names the key). Restart the daemon
to apply a change (`install` again, or restart the service); it logs the limits in force as
`pacing limits` when it starts, and `list_browsers` shows the burst cap in `pacing_burst.cap`.

The safe level is not known. The defaults sit well below the one observed case of friction (about
63 loads in 47 minutes, 13 of them in the last 10, drew a "continue shopping" checkpoint). Raising
a cap trades waiting time for a higher chance of such a checkpoint, which costs a 60 minute
cool-down and a click by you, and the two-computer sum still applies.

## 5. Connect Claude

The connector URL is `https://<your-hostname>/mcp`.

**claude.ai (unverified: menu names change).** Settings, Connectors, add a custom connector, paste
the URL and connect. Your browser opens `https://<your-hostname>/authorize`: sign in through
Cloudflare Access, check the client name and where access will be sent, type the **app
password**, and press Allow. Claude then lists the tools.

**Claude Code (unverified).**

```
claude mcp add --transport http rainforest https://<your-hostname>/mcp
```

Then run `/mcp` inside Claude Code and authenticate the `rainforest` server; the same consent page
opens in your browser.

Try `list_browsers` first. Each connection chooses its own default computer with `select_browser`.

## 6. Updating

- **The Worker.** If it is connected to Workers Builds (step 3), a push to `main` deploys it and
  the commit gets a `Workers Builds: rainforest-hub` check when the deploy is done; do not deploy
  by hand as well. Otherwise pull the new commit, `npm ci`, and run the same
  `npx wrangler deploy --domain <your-hostname>` again from `packages/worker`. The secrets
  persist either way. A daemon older than your `MIN_DAEMON_VERSION`, if you set one, is told to
  update and is refused until it does.
- **The daemon.** It checks for a newer signed release 20 seconds after it starts, then every
  `check_interval_s` (`setup` writes 600 seconds on a first run; the schema default is 6 hours;
  the minimum is 300), and whenever the hub sends a hint. `node packages/daemon/src/main.ts update`
  runs a check now. Despite the usage text, `update --check` is parsed but ignored: the command
  always applies a newer verified release.
- **Your own releases.** Releases are built, signed and published by `.github/workflows/release.yml`
  on every push to `main`, and need a signing key that only you hold: run
  `node scripts/release-keygen.mjs`, commit the printed public key into
  `packages/daemon/src/updater/release-key.ts`, store the private key only as the
  `RELEASE_SIGNING_KEY` Actions secret in your fork, and point each daemon's `--repo` at your fork.
  A daemon trusts only the keys embedded in its own build. If the repository is private, the
  daemon needs a read token in `secrets.json` under `update_token` (no command sets it for you).

## 7. Uninstalling

- `node packages/daemon/src/main.ts uninstall` removes the autostart registration. It leaves the
  config, device key, secrets, logs and installed versions in the app directory; delete that
  directory to remove everything.
- On `/admin`, **Revoke** the device so the hub forgets it and closes its socket.
- Remove the connector from claude.ai or Claude Code.
- To remove the hub, delete the Worker (`npx wrangler delete`, **unverified**) and the Access
  application, and remove the extension from Chrome if you no longer want it.

## Troubleshooting

### Where to look

```
node packages/daemon/src/main.ts status          # version, service state, config summary, last log lines
node packages/daemon/src/main.ts status --json
node packages/daemon/src/main.ts selftest        # can this build run here? exit 0 or 1
node packages/daemon/src/main.ts run             # run in the foreground to watch it
```

`doctor` is a quick read-only health report, one line per check, exit 0 only if all pass:

```
node packages/daemon/src/main.ts doctor
node packages/daemon/src/main.ts doctor --live
```

It checks that `config.json` exists and is valid, that the computer is paired, that the extension
token is stored, that `<hub_url>/healthz` answers with `"configured":true`, and that the broker port
is listening (in `embedded` mode only the running daemon listens there, so a stopped daemon shows
as FAIL). `--live` adds, in `external` broker mode, whether the extension is connected to that
broker and has a token. `capture` is a developer placeholder: it prints that it is not implemented
and exits 1.

Logs are JSON lines in the `logs` folder of the app directory:

| OS      | Folder                                           |
| ------- | ------------------------------------------------ |
| macOS   | `~/Library/Application Support/rainforest/logs/` |
| Windows | `%LOCALAPPDATA%\rainforest\logs\`                |

`daemon.log` rotates at 5 MiB and keeps three files; `launcher.log` holds start failures of the
launcher; on macOS `launchd.out.log` and `launchd.err.log` hold the service's output. For more
detail, stop the service and run it in the foreground with `RAINFOREST_LOG_LEVEL=debug`. Do not
run a second copy while the service is up: a newer connection for the same device replaces the
older one.

### Hub and consent

| Symptom                                                               | Likely cause and fix                                                                                                   |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `/healthz` says `"configured":false`; others 503                      | A required secret is missing or malformed (see the formats in step 3)                                                  |
| `/authorize` or `/admin` says 401 "sign in through Cloudflare Access" | The Access application does not cover that path, or `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN` or `OWNER_EMAIL` does not match |
| "wrong app password" (403)                                            | Retype it; it is case sensitive                                                                                        |
| "too many attempts" (429)                                             | Five failures in 15 minutes lock the form for everyone; wait 15 minutes and start again from the client                |
| "bad origin" (400)                                                    | `PUBLIC_BASE_URL` does not match the hostname you are using                                                            |

### Pairing and connection

| Symptom                                       | Likely cause and fix                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pair`: refused, "already pending"            | Reject or wait out the earlier pairing on `/admin` (10 minutes)                                    |
| `pair`: refused, "this key is already paired" | Revoke the old device on `/admin`, or you already paired this computer                             |
| Daemon never shows online                     | Check `status` and `daemon.log`; confirm `hub_url`; a revoked device is closed with "revoked"      |
| `setup`: "port ... is in use"                 | Stop the running daemon (or uninstall autostart), then run `setup` again                           |
| `setup`: could not obtain the extension token | The extension is not installed in that profile, the profile name is wrong, or Chrome did not start |

### Tool errors

The codes are defined in docs/TOOLS.md; what to do about the common ones:

| Code                | What to do                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no_browser_online` | No computer is connected: start the daemon, check `status`, check `/admin`                                                                                                                  |
| `browser_offline`   | The named computer is offline, or its extension cannot be reached: is Chrome running with the profile and the extension installed and enabled?                                              |
| `needs_human`       | Amazon asked for a captcha, a sign-in, a checkpoint or another check: handle it in that Chrome yourself. The computer then cools down for 60 minutes (nothing is retried or solved for you) |
| `throttled`         | A pacing cap or cool-down; wait exactly `retry_after_s`. `list_browsers` shows `cooling_down_until` and what is left (`pacing_burst`, `pacing_budget`). Limits are per computer; see 4d     |
| `busy`              | That computer already has 4 calls queued; retry in about 15 seconds                                                                                                                         |
| `daemon_outdated`   | The daemon is below `MIN_DAEMON_VERSION` and is updating; retry in a minute                                                                                                                 |
| `blocked_by_policy` | The URL policy refused a page; this is working as intended                                                                                                                                  |
| `unsupported`       | Something not implemented (`move_list_item` with `copy: true`), or a page Amazon does not offer (archived orders, search history)                                                           |
| `needs_choice`      | `add_to_cart` refused the offer and added nothing (flags, price or seller changed, gone, out of stock); read `details` and ask again                                                        |
| `timeout`           | A page did not load in 45 seconds, or the call passed 225 seconds                                                                                                                           |
