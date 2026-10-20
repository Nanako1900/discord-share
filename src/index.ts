import { apiError, apiFailure, apiSuccess } from "./api";
import { raceTimeout } from "./async";
import { getSnapshot, isReportedLoadError } from "./cache";
import { createCacheStore } from "./cache-store";
import { ConfigError, readConfig, type AppConfig } from "./config";
import { fetchDiscordData, inviteCodeFrom } from "./discord";
import { buildMeta, SECURITY_HEADERS } from "./html";
import { applyPatch, joinUrlFor, pageDataFrom, pagePatches, snapshotOf, type PagePatch } from "./page";
import { buildSnapshot, type GuildSnapshot, type StoredSnapshot } from "./snapshot";

type SnapshotLoader = () => Promise<GuildSnapshot>;

// v4: the stored snapshot gained `rejectedInviteCode` (v3: entry `state`, snapshot `sources`, Game `id`).
const CACHE_KEY_PATH = "/__cache/snapshot/v4";
// The page embeds live data, so browsers must revalidate; the snapshot itself is edge-cached.
const PAGE_CACHE_CONTROL = "no-cache";
/** Don't hold the HTML (and link-preview crawlers) hostage to a slow Discord. */
const PAGE_DATA_TIMEOUT_MS = 2_000;

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const { pathname } = new URL(request.url);
		const isApi = pathname.startsWith("/api/");
		if (pathname !== "/" && !isApi) return env.ASSETS.fetch(request);

		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
		}

		let config: AppConfig;
		try {
			config = readConfig(env);
		} catch (error) {
			console.error("Invalid configuration", error);
			return apiError(error instanceof ConfigError ? error.message : "Invalid configuration", 500);
		}

		// Key includes the guild + invite so switching servers never serves the previous one.
		const cacheKey = `${config.siteUrl}${CACHE_KEY_PATH}/${config.guildId}/${config.inviteCode ?? "widget"}`;
		const loadSnapshot: SnapshotLoader = () =>
			getSnapshot({
				store: createCacheStore(caches.default, cacheKey),
				load: (previous) => loadFromDiscord(config, previous),
				now: new Date(),
				waitUntil: (promise) => ctx.waitUntil(promise),
				onError: (error) => console.error("Discord snapshot refresh or cache access failed", error),
			});

		if (pathname === "/api/guild") return handleApi(loadSnapshot);
		if (isApi) return apiError("Not found", 404);
		return handlePage(request, env, ctx, config, loadSnapshot);
	},
} satisfies ExportedHandler<Env>;

async function loadFromDiscord(config: AppConfig, previous: StoredSnapshot | null): Promise<StoredSnapshot> {
	const data = await fetchDiscordData(config, (url, init) => fetch(url, init), {
		fallbackInviteCode: inviteCodeFrom(previous?.inviteUrl),
		onWarn: (message, error) => console.warn(message, error),
	});
	return buildSnapshot(data, config, new Date(), previous);
}

function logLoadError(context: string, error: unknown): void {
	// getSnapshot reports every refresh failure itself (from its waitUntil chain, so it is
	// logged even if this request is cancelled); its loading/backoff rejections only
	// describe cache state. Anything else is unexpected and logged here.
	if (!isReportedLoadError(error)) console.error(context, error);
}

async function handleApi(load: SnapshotLoader): Promise<Response> {
	try {
		return apiSuccess(await load());
	} catch (error) {
		logLoadError("Failed to load Discord data", error);
		return apiFailure(error);
	}
}

async function handlePage(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	config: AppConfig,
	load: SnapshotLoader,
): Promise<Response> {
	const loading = load();
	// The refresh itself is kept alive by getSnapshot; this only makes sure a failure that
	// settles after the page stops waiting is never silent (and never logged twice).
	ctx.waitUntil(loading.catch((error: unknown) => logLoadError("Failed to load Discord data for page", error)));

	const [asset, result] = await Promise.all([
		env.ASSETS.fetch(new URL("/", request.url)),
		raceTimeout(loading, PAGE_DATA_TIMEOUT_MS),
	]);
	if (!asset.ok) return asset;

	// Without a snapshot (pending, loading elsewhere, backoff, failure) the page renders
	// without data and the client fetches /api/guild.
	const data = pageDataFrom(result);
	const snapshot = snapshotOf(data);
	const meta = buildMeta(snapshot, config.siteUrl, config.siteName);
	const name = snapshot?.name ?? config.siteName;
	const page = rewritePage(asset, pagePatches(meta, snapshot, name, joinUrlFor(data, config.inviteCode)));
	const headers = new Headers(page.headers);
	for (const [header, value] of Object.entries(SECURITY_HEADERS)) headers.set(header, value);
	headers.set("Cache-Control", PAGE_CACHE_CONTROL);
	headers.delete("ETag");
	return new Response(page.body, { status: page.status, headers });
}

function rewritePage(res: Response, patches: readonly PagePatch[]): Response {
	const rewriter = new HTMLRewriter();
	for (const patch of patches) rewriter.on(patch.selector, { element: (el) => applyPatch(el, patch) });
	return rewriter.transform(res);
}
