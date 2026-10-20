# discord-share

The share page for the Discord server **Nanako's Community**, running on Cloudflare Workers: **https://discord.nanako.org**

- Cool, restrained modern style: light slate background, translucent cards, hairline borders, sparing use of the server's teal brand color.
- Centered on the page, never full width.
- On desktop (≥ 1040px) it shows two cards side by side: an identity card and a live-activity card. On phones the cards stack.
- When the link is shared to Discord or social media, the preview card includes the live member and online counts.

No bot token and no secrets are needed. The page shows as much as Discord's public APIs expose:

| Source | Content shown |
|---|---|
| `GET /api/v10/invites/{code}?with_counts=true` | Name, icon, invite background or banner, description, member and online counts, boost tier and count, verification level, feature list, invite channel, brand color, server tag |
| `GET /api/guilds/{id}/widget.json` | Online members (avatar, status, current game), all voice channels and who is in them (mute/deafen state), online count |
| `GET /api/v10/applications/{id}/rpc` | Names and icons of the server's common games |
| Guild ID (snowflake) | Server creation date |

## Configuration

Set the `vars` in [`wrangler.jsonc`](wrangler.jsonc):

| Variable | Description |
|---|---|
| `GUILD_ID` | Server ID, as a **quoted string**. Enable Developer Mode, then right-click the server → Copy Server ID. |
| `INVITE_CODE` | Optional. A **never-expiring** invite code (the part after `discord.gg/`). If left empty, the page uses the rotating invite from the widget, which Discord renews about every 24 hours. Configuring a permanent invite is recommended. |
| `SITE_URL` | Site address, used for `canonical` and `og:url`. |
| `SITE_NAME` | Display name used when Discord data can't be fetched. |

You also need to turn on **Server Settings → Widget → Enable Server Widget** in Discord and choose an "Invite Channel". Without the widget, the live-activity card isn't shown, and with an empty `INVITE_CODE` there's no invite link at all.

After changing `wrangler.jsonc`, run `npm run cf-typegen` to regenerate `worker-configuration.d.ts`.

## Architecture

```
Browser ─► Worker (discord.nanako.org)
            ├─ /            Fetch public/index.html; HTMLRewriter injects meta tags, the server name, the join link, and first-paint data
            ├─ /api/guild   Merge Invite + Widget (+ game names) into a GuildSnapshot → { success, data, error }
            └─ other paths  Served directly from the static files in public/
```

**Caching** (Cache API, per data center):
- Data is served directly for 120 seconds after a refresh. After that, the old data is returned while a refresh runs in the background.
- A 30-second **lease** is written before each refresh, and concurrent requests in the same isolate share a single load (singleflight), so a traffic spike never turns into a flood of Discord requests.
- If the data is older than 10 minutes, a request waits at most 1.5 seconds for fresh data; otherwise it gets the old data with a "数据可能有延迟" (data may be delayed) notice.
- After a failure there are **no retries for 60 seconds** (negative cache), and a failure never overwrites good data another request has just stored.
- If only one of the Invite or Widget sources fails, that half keeps its previous data along with its own fetch time (`sources`), so outdated halves are flagged stale instead of looking fresh.
- While the very first load is in progress, `/api/guild` answers `503` with `Retry-After`; the page retries automatically.
- The page waits at most 2 seconds for Discord. After that it renders immediately, and the client fills in data via `/api/guild`.

**Security:**
- Strict CSP: scripts, styles and connections are restricted to the same origin; images may also come from the Discord CDN.
- HSTS and `X-Frame-Options` are set.
- First-paint JSON is escaped for safe embedding in a `<script>` tag.
- The frontend renders only via `textContent`.
- Avatars, image hashes, brand color, invite links and the invite's guild ownership are all validated.

| File | Purpose |
|---|---|
| `src/index.ts` | Routing, HTMLRewriter injection, security headers |
| `src/page.ts` | The page injection plan (meta, name, join link, two-card layout, first-paint data) as a pure, tested function |
| `src/api.ts` | `/api/guild` response envelope and status codes |
| `src/config.ts` | Validates the environment variables |
| `src/discord.ts` | Calls the Discord API (5s timeout; distinguishes a disabled widget from a failed one; checks the invite belongs to this guild) |
| `src/snapshot.ts` | Normalizes data into a `GuildSnapshot` and merges partial failures with the previous snapshot |
| `src/cache.ts`, `src/cache-store.ts` | Cache state machine (lease, singleflight, negative cache) and Cache API storage |
| `src/async.ts` | Small timeout helpers |
| `src/html.ts` | Share-card meta, script-safe JSON, CSP |
| `public/` | The page (plain HTML / CSS / JS, no build step) |

## Local development

```bash
npm install
npm run dev          # http://localhost:8787
npm test             # unit tests
npm run coverage     # coverage (80% threshold)
npm run typecheck
```

To check the single-card layout for a server without the widget, run a second instance with its own local state directory:

```bash
npx wrangler dev --port 8788 --persist-to .wrangler/state-no-widget --var GUILD_ID:613425648685547541 --var INVITE_CODE:discord-developers
```

## Deployment

- **Automatic:** in the Cloudflare Dashboard, go to Workers & Pages → `discord-share` → Settings → Builds and connect this repository. Every push to `main` then deploys.
- **Manual:** `npm run deploy` (requires `npx wrangler login` first)

The custom domain `discord.nanako.org` is managed by `routes[].custom_domain` in `wrangler.jsonc`. Deploying creates its DNS record and certificate automatically.
