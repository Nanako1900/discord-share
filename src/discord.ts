import { sleep } from "./async";

/** Minimal fetch signature so tests can inject a fake without touching globals. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface DiscordInviteGuild {
	id: string;
	name: string;
	description: string | null;
	icon: string | null;
	banner: string | null;
	splash: string | null;
	features: string[];
	verification_level?: number;
	premium_tier?: number;
	premium_subscription_count?: number;
}

export interface DiscordGuildProfile {
	brand_color_primary?: string | null;
	game_application_ids?: string[];
	tag?: string | null;
}

export interface DiscordInvite {
	code: string;
	guild: DiscordInviteGuild;
	channel?: { id: string; name: string } | null;
	profile?: DiscordGuildProfile | null;
	approximate_member_count?: number;
	approximate_presence_count?: number;
}

export interface DiscordWidgetMember {
	id: string;
	username: string;
	status: string;
	avatar_url?: string | null;
	game?: { name: string };
	channel_id?: string;
	mute?: boolean;
	deaf?: boolean;
	self_mute?: boolean;
	self_deaf?: boolean;
	suppress?: boolean;
}

export interface DiscordWidgetChannel {
	id: string;
	name: string;
	position: number;
}

export interface DiscordWidget {
	id: string;
	name: string;
	instant_invite: string | null;
	channels: DiscordWidgetChannel[];
	members: DiscordWidgetMember[];
	presence_count: number;
}

export interface DiscordApplication {
	id: string;
	name: string;
	icon: string | null;
}

export interface DiscordData {
	invite: DiscordInvite | null;
	/** null when the widget is disabled *or* failed — see `failed.widget`. */
	widget: DiscordWidget | null;
	/** Featured games whose lookup succeeded, in profile order. */
	applications: DiscordApplication[];
	/** Featured game ids whose lookup failed (callers may keep cached entries for them). */
	failedApplicationIds: string[];
	/** Which sources errored (as opposed to being intentionally absent). */
	failed: { invite: boolean; widget: boolean };
	/** The code that was looked up — configured, the widget's or the fallback (null when there was none). */
	inviteCode: string | null;
	/** `inviteCode` resolved to a different guild, so it must never be advertised. */
	inviteRejected: boolean;
}

export interface FetchDiscordOptions {
	/** Invite code to try when none is configured and the widget yields none (e.g. from the cached snapshot). */
	fallbackInviteCode?: string | null;
	/** Receives failures that are absorbed rather than thrown (partial outages, game lookups). */
	onWarn?: (message: string, error: unknown) => void;
}

export class DiscordApiError extends Error {
	override name = "DiscordApiError";
	constructor(
		message: string,
		readonly status: number | null = null,
	) {
		super(message);
	}
}

/** Thrown when an invite resolves to a guild other than the configured one. */
export class InviteGuildMismatchError extends DiscordApiError {
	override name = "InviteGuildMismatchError";
}

/** Per-request timeout; a refresh makes at most three sequential rounds (widget → invite → games). */
export const REQUEST_TIMEOUT_MS = 5_000;
const API_BASE = "https://discord.com/api";
const USER_AGENT = "discord-share/0.1 (+https://discord.nanako.org)";
const WIDGET_DISABLED_CODE = 50004;
const MAX_GAME_LOOKUPS = 3;
const SNOWFLAKE_RE = /^\d{17,20}$/;
const INVITE_URL_CODE_RE = /^https:\/\/(?:discord\.gg|discord\.com\/invite)\/([A-Za-z0-9-]+)$/;

/** Short per-route 429s are common on Cloudflare's shared egress IPs (retry_after ≈ 1s). */
const MAX_RATE_LIMIT_RETRIES = 2;

/**
 * GET with a total budget of REQUEST_TIMEOUT_MS, retries included: a 429 whose
 * retry_after fits in the remaining budget is waited out and retried (at most twice).
 */
async function request(fetcher: Fetcher, url: string): Promise<Response> {
	const deadline = Date.now() + REQUEST_TIMEOUT_MS;
	for (let attempt = 0; ; attempt++) {
		const res = await fetcher(url, {
			headers: { Accept: "application/json", "User-Agent": USER_AGENT },
			// Workers rejects "error"; with "manual" a 3xx is simply !ok and treated as a failure.
			redirect: "manual",
			signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
		});
		if (res.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) return res;

		const text = await res.text().catch(() => "");
		const waitMs = retryWaitMs(res.headers, text);
		if (waitMs === null || Date.now() + waitMs >= deadline) {
			return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
		}
		await sleep(waitMs);
	}
}

/**
 * Milliseconds to wait before retrying a 429, or null when unknown. The body's
 * retry_after wins: Discord's Retry-After header can contradict it (seen: 300 vs 0.3).
 * Global limits are retried too — on shared egress IPs they are short.
 */
function retryWaitMs(headers: Headers, body: string): number | null {
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(body);
	} catch {
		// Non-JSON 429 (e.g. an edge block page): use the Retry-After header instead.
	}
	const seconds =
		isObject(parsed) && typeof parsed.retry_after === "number" ? parsed.retry_after : Number(headers.get("Retry-After") ?? NaN);
	return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const ERROR_BODY_EXCERPT = 200;

/** An HTTP failure with enough detail in the message (rate-limit headers, body excerpt) to diagnose from logs. */
async function httpError(what: string, res: Response): Promise<DiscordApiError> {
	const details = [
		res.headers.get("Retry-After") && `retry-after=${res.headers.get("Retry-After")}`,
		res.headers.get("X-RateLimit-Scope") && `scope=${res.headers.get("X-RateLimit-Scope")}`,
	].filter(Boolean);
	const body = await res.text().catch(() => "");
	const excerpt = body.replace(/\s+/g, " ").trim().slice(0, ERROR_BODY_EXCERPT);
	const suffix = [details.join(" "), excerpt && `body: ${excerpt}`].filter(Boolean).join("; ");
	return new DiscordApiError(`${what} failed with HTTP ${res.status}${suffix ? ` (${suffix})` : ""}`, res.status);
}

export async function fetchInvite(code: string, fetcher: Fetcher): Promise<DiscordInvite> {
	const res = await request(fetcher, `${API_BASE}/v10/invites/${encodeURIComponent(code)}?with_counts=true`);
	if (!res.ok) {
		throw await httpError("Invite request", res);
	}

	const body: unknown = await res.json();
	if (!isObject(body) || !isObject(body.guild) || typeof body.guild.id !== "string") {
		throw new DiscordApiError("Invite response is missing guild data", res.status);
	}
	return body as unknown as DiscordInvite;
}

/** Returns null when the server has the widget disabled. */
export async function fetchWidget(guildId: string, fetcher: Fetcher): Promise<DiscordWidget | null> {
	const res = await request(fetcher, `${API_BASE}/guilds/${encodeURIComponent(guildId)}/widget.json`);

	if (res.status === 403) {
		const body: unknown = await res.json().catch(() => null);
		if (isObject(body) && body.code === WIDGET_DISABLED_CODE) return null;
	}
	if (!res.ok) {
		throw await httpError("Widget request", res);
	}

	const body: unknown = await res.json();
	if (!isObject(body) || !Array.isArray(body.members) || !Array.isArray(body.channels)) {
		throw new DiscordApiError("Widget response has an unexpected shape", res.status);
	}
	return body as unknown as DiscordWidget;
}

/** Public application metadata (used to name the server's featured games). */
export async function fetchApplication(id: string, fetcher: Fetcher): Promise<DiscordApplication> {
	const res = await request(fetcher, `${API_BASE}/v10/applications/${encodeURIComponent(id)}/rpc`);
	if (!res.ok) {
		throw await httpError("Application request", res);
	}

	const body: unknown = await res.json();
	if (!isObject(body) || typeof body.name !== "string") {
		throw new DiscordApiError("Application response is missing a name", res.status);
	}
	return { id, name: body.name, icon: typeof body.icon === "string" ? body.icon : null };
}

/**
 * Fetches widget + invite (+ featured game names). Without a configured invite
 * code, the widget's rotating instant invite is used, then `fallbackInviteCode`.
 * Throws only when neither invite nor widget yields anything — unless the invite
 * was rejected for belonging to another guild: that verdict is always returned,
 * so it reaches the snapshot (and the cache) and the code is never advertised.
 * Every failure that is absorbed instead of thrown is reported through `onWarn`.
 */
export async function fetchDiscordData(
	config: { guildId: string; inviteCode: string | null },
	fetcher: Fetcher,
	{ fallbackInviteCode = null, onWarn = () => undefined }: FetchDiscordOptions = {},
): Promise<DiscordData> {
	const widgetPromise = fetchWidget(config.guildId, fetcher);
	const codePromise = inviteCodeToLookUp(config.inviteCode, widgetPromise, fallbackInviteCode);
	const invitePromise = codePromise.then((code) => lookUpInvite(code, config.guildId, fetcher));

	const [inviteResult, widgetResult] = await Promise.allSettled([invitePromise, widgetPromise]);
	const inviteCode = await codePromise;
	const invite = inviteResult.status === "fulfilled" ? inviteResult.value : null;
	const widget = widgetResult.status === "fulfilled" ? widgetResult.value : null;
	const inviteRejected = inviteResult.status === "rejected" && inviteResult.reason instanceof InviteGuildMismatchError;

	if (!invite && !widget && !inviteRejected) {
		const reasons = [inviteResult, widgetResult]
			.map((r) => (r.status === "rejected" ? describeError(r.reason) : "widget disabled"))
			.join("; ");
		throw new DiscordApiError(`No Discord data available (${reasons})`);
	}
	if (inviteRejected) onWarn("Discord invite belongs to another guild; it will not be advertised", inviteResult.reason);
	else if (inviteResult.status === "rejected") onWarn("Discord invite request failed; keeping cached guild info", inviteResult.reason);
	if (widgetResult.status === "rejected") onWarn("Discord widget request failed; keeping cached widget", widgetResult.reason);

	const games = invite ? await fetchGames(invite, fetcher, onWarn) : { applications: [], failedIds: [] };
	return {
		invite,
		widget,
		applications: games.applications,
		failedApplicationIds: games.failedIds,
		failed: { invite: inviteResult.status === "rejected", widget: widgetResult.status === "rejected" },
		inviteCode,
		inviteRejected,
	};
}

/** Configured code, else the widget's instant invite, else the fallback. Never rejects. */
async function inviteCodeToLookUp(
	configured: string | null,
	widgetPromise: Promise<DiscordWidget | null>,
	fallback: string | null,
): Promise<string | null> {
	return configured ?? (await widgetInviteCode(widgetPromise)) ?? fallback;
}

async function lookUpInvite(code: string | null, guildId: string, fetcher: Fetcher): Promise<DiscordInvite> {
	if (!code) throw new DiscordApiError("No invite code configured, from the widget or cached");
	const invite = await fetchInvite(code, fetcher);
	if (invite.guild.id !== guildId) {
		throw new InviteGuildMismatchError(`Invite ${code} belongs to guild ${invite.guild.id}, expected ${guildId}`);
	}
	return invite;
}

/** The widget's instant-invite code, or null when the widget is disabled, failed or has none. */
async function widgetInviteCode(widgetPromise: Promise<DiscordWidget | null>): Promise<string | null> {
	try {
		return inviteCodeFrom((await widgetPromise)?.instant_invite);
	} catch {
		return null; // the widget failure itself is reported by fetchDiscordData
	}
}

/** Best effort: a failed lookup is reported (and warned about) instead of failing the fetch. */
async function fetchGames(
	invite: DiscordInvite,
	fetcher: Fetcher,
	onWarn: (message: string, error: unknown) => void,
): Promise<{ applications: DiscordApplication[]; failedIds: string[] }> {
	const ids = (invite.profile?.game_application_ids ?? [])
		.filter((id): id is string => typeof id === "string" && SNOWFLAKE_RE.test(id))
		.slice(0, MAX_GAME_LOOKUPS);
	const results = await Promise.allSettled(ids.map((id) => fetchApplication(id, fetcher)));
	const failures = results.flatMap((r, i) => (r.status === "rejected" ? [{ id: ids[i], reason: r.reason as unknown }] : []));
	for (const { id, reason } of failures) onWarn(`Discord game application lookup failed for ${id}; keeping cached game`, reason);

	return {
		applications: results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])),
		failedIds: failures.map((f) => f.id),
	};
}

/** Extracts the code from a plain Discord invite url (discord.gg/<code> or discord.com/invite/<code>). */
export function inviteCodeFrom(url: string | null | undefined): string | null {
	return url?.match(INVITE_URL_CODE_RE)?.[1] ?? null;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
