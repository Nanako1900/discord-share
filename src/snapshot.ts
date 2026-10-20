import {
	inviteCodeFrom,
	type DiscordApplication,
	type DiscordData,
	type DiscordInvite,
	type DiscordWidget,
	type DiscordWidgetMember,
} from "./discord";

export interface Member {
	name: string;
	avatarUrl: string | null;
	status: string;
	activity: string | null;
	/** Present only for members currently in a voice channel. */
	voice: { muted: boolean; deafened: boolean } | null;
}

export interface VoiceChannel {
	name: string;
	members: Member[];
}

export interface Game {
	/** Discord application id, so a failed lookup can keep the cached entry. */
	id: string;
	name: string;
	iconUrl: string | null;
}

/** Everything that comes from the Invite API. */
export interface GuildInfo {
	description: string | null;
	iconUrl: string | null;
	/** PNG variant for link-preview crawlers that don't support webp/gif. */
	ogImageUrl: string | null;
	bannerUrl: string | null;
	brandColor: string | null;
	tag: string | null;
	memberCount: number | null;
	onlineCount: number | null;
	boostCount: number;
	boostTier: number;
	verificationLevel: number | null;
	features: string[];
	inviteChannel: string | null;
	games: Game[];
}

/** Everything that comes from widget.json. */
export interface WidgetInfo {
	onlineCount: number;
	members: Member[];
	voiceChannels: VoiceChannel[];
}

/** ISO time of the last successful fetch behind each part (null when the part is absent). */
export interface SourceTimes {
	guild: string | null;
	widget: string | null;
}

/** The normalized shape served by /api/guild and embedded into the page. */
export interface GuildSnapshot {
	id: string;
	name: string;
	createdAt: string;
	inviteUrl: string | null;
	guild: GuildInfo | null;
	widget: WidgetInfo | null;
	sources: SourceTimes;
	/** The *oldest* source time, so carried-over data ages honestly (build time when there is no source). */
	fetchedAt: string;
	stale: boolean;
}

/**
 * What the Worker keeps between refreshes: the served snapshot plus state that must
 * never leave the Worker (see publicSnapshot).
 */
export interface StoredSnapshot extends GuildSnapshot {
	/**
	 * Invite code Discord resolved to another guild. It stays withheld — also while later
	 * lookups fail for unrelated reasons (429, 5xx, timeouts) — until a lookup of that very
	 * code matches this guild again. Possibly the invite of someone else's private server,
	 * so it is never published either.
	 */
	rejectedInviteCode: string | null;
}

interface SnapshotConfig {
	guildId: string;
	inviteCode: string | null;
	siteName: string;
}

const CDN = "https://cdn.discordapp.com";
const DISCORD_EPOCH_MS = 1_420_070_400_000n;
const HASH_RE = /^[A-Za-z0-9_]+$/;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const FEATURE_RE = /^[A-Z0-9_]{2,64}$/;
const MAX_TAG_LENGTH = 8;

interface Part<T> {
	value: T | null;
	at: string | null;
}

/**
 * Normalizes Discord payloads. When a source *failed* (not merely absent), the
 * matching part of `previous` is kept — with its original timestamp — so a
 * transient error never degrades already-cached data nor makes it look newer.
 */
export function buildSnapshot(
	data: DiscordData,
	config: SnapshotConfig,
	now: Date,
	previous: StoredSnapshot | null = null,
): StoredSnapshot {
	const nowIso = now.toISOString();
	const { invite, widget, failed } = data;
	const guild: Part<GuildInfo> = invite
		? { value: guildInfo(invite, data, previous?.guild?.games ?? []), at: nowIso }
		: carried(failed.invite, previous?.guild ?? null, previous?.sources.guild, previous);
	const widgetInfo: Part<WidgetInfo> = widget
		? { value: toWidgetInfo(widget), at: nowIso }
		: carried(failed.widget, previous?.widget ?? null, previous?.sources.widget, previous);
	const rejectedInviteCode = rejectedCode(data, previous);

	return {
		id: config.guildId,
		name: invite?.guild.name ?? widget?.name ?? previous?.name ?? config.siteName,
		createdAt: snowflakeDate(config.guildId),
		inviteUrl: resolveInviteUrl(config.inviteCode, data, previous, rejectedInviteCode),
		rejectedInviteCode,
		guild: guild.value,
		widget: widgetInfo.value,
		sources: { guild: guild.at, widget: widgetInfo.at },
		fetchedAt: oldest([guild.at, widgetInfo.at]) ?? nowIso,
		stale: false,
	};
}

/**
 * Exactly the public fields — a whitelist, so internal state (such as a rejected invite
 * code) can never reach the API body or the page, whatever else a stored snapshot holds.
 */
export function publicSnapshot(snapshot: GuildSnapshot): GuildSnapshot {
	const { id, name, createdAt, inviteUrl, guild, widget, sources, fetchedAt, stale } = snapshot;
	return { id, name, createdAt, inviteUrl, guild, widget, sources, fetchedAt, stale };
}

function carried<T>(failed: boolean, value: T | null, at: string | null | undefined, previous: GuildSnapshot | null): Part<T> {
	if (!failed || value === null) return { value: null, at: null };
	return { value, at: at ?? previous?.fetchedAt ?? null };
}

function oldest(times: ReadonlyArray<string | null>): string | null {
	const known = times.filter((t): t is string => t !== null);
	return known.length === 0 ? null : known.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
}

/**
 * The code Discord says belongs to another guild: the one just rejected, else the
 * cached verdict — which only a successful lookup of that very code lifts.
 */
function rejectedCode({ invite, inviteCode, inviteRejected }: DiscordData, previous: StoredSnapshot | null): string | null {
	if (inviteRejected) return inviteCode;
	const cached = previous?.rejectedInviteCode ?? null;
	return invite && inviteCode === cached ? null : cached;
}

/**
 * The configured code, else the widget's validated instant invite, else — only when
 * the widget request *failed* — the previous url. A url carrying the rejected code
 * is never returned, whichever source offers it.
 */
function resolveInviteUrl(
	inviteCode: string | null,
	{ widget, failed }: DiscordData,
	previous: GuildSnapshot | null,
	rejectedInviteCode: string | null,
): string | null {
	const usable = (code: string | null): boolean => code !== null && code !== rejectedInviteCode;
	if (usable(inviteCode)) return `https://discord.gg/${inviteCode}`;
	const instant = widget?.instant_invite ?? null;
	if (usable(inviteCodeFrom(instant))) return instant;
	const cachedUrl = failed.widget ? (previous?.inviteUrl ?? null) : null;
	return usable(inviteCodeFrom(cachedUrl)) ? cachedUrl : null;
}

function guildInfo(
	invite: DiscordInvite,
	{ applications, failedApplicationIds }: DiscordData,
	previousGames: readonly Game[],
): GuildInfo {
	const { guild, profile } = invite;
	const icon = validHash(guild.icon);
	const banner = validHash(guild.banner);
	const splash = validHash(guild.splash);
	const tag = profile?.tag;

	let bannerUrl: string | null = null;
	if (banner) bannerUrl = `${CDN}/banners/${guild.id}/${banner}.webp?size=1024`;
	else if (splash) bannerUrl = `${CDN}/splashes/${guild.id}/${splash}.webp?size=1024`;

	return {
		description: guild.description?.trim() || null,
		iconUrl: icon ? `${CDN}/icons/${guild.id}/${icon}.${icon.startsWith("a_") ? "gif" : "webp"}?size=256` : null,
		ogImageUrl: icon ? `${CDN}/icons/${guild.id}/${icon}.png?size=512` : null,
		bannerUrl,
		brandColor: typeof profile?.brand_color_primary === "string" && HEX_COLOR_RE.test(profile.brand_color_primary)
			? profile.brand_color_primary.toLowerCase()
			: null,
		tag: typeof tag === "string" && tag.length > 0 && tag.length <= MAX_TAG_LENGTH ? tag : null,
		memberCount: invite.approximate_member_count ?? null,
		onlineCount: invite.approximate_presence_count ?? null,
		boostCount: guild.premium_subscription_count ?? 0,
		boostTier: guild.premium_tier ?? 0,
		verificationLevel: guild.verification_level ?? null,
		features: (guild.features ?? []).filter((f): f is string => typeof f === "string" && FEATURE_RE.test(f)),
		inviteChannel: invite.channel?.name ?? null,
		games: mergeGames(invite, applications.map(toGame), failedApplicationIds, previousGames),
	};
}

function toGame(app: DiscordApplication): Game {
	const icon = validHash(app.icon);
	return { id: app.id, name: app.name, iconUrl: icon ? `${CDN}/app-icons/${app.id}/${icon}.webp?size=64` : null };
}

/** Fresh games plus cached ones whose lookup failed, in the server profile's order. */
function mergeGames(invite: DiscordInvite, fresh: Game[], failedIds: readonly string[], previousGames: readonly Game[]): Game[] {
	const kept = previousGames.filter((game) => failedIds.includes(game.id));
	const order = invite.profile?.game_application_ids ?? [];
	return [...fresh, ...kept].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

function toWidgetInfo(widget: DiscordWidget): WidgetInfo {
	const voiceChannels = [...widget.channels]
		.sort((a, b) => a.position - b.position)
		.map((channel) => ({
			name: channel.name,
			members: widget.members.filter((m) => m.channel_id === channel.id).map(toMember),
		}));

	return { onlineCount: widget.presence_count, members: widget.members.map(toMember), voiceChannels };
}

function toMember(member: DiscordWidgetMember): Member {
	const avatar = member.avatar_url;
	return {
		name: member.username,
		// Only trust Discord's CDN; anything else is dropped (also enforced by CSP).
		avatarUrl: typeof avatar === "string" && avatar.startsWith(`${CDN}/`) ? avatar : null,
		status: member.status,
		activity: member.game?.name ?? null,
		voice: member.channel_id
			? {
					muted: Boolean(member.self_mute || member.mute || member.suppress),
					deafened: Boolean(member.self_deaf || member.deaf),
				}
			: null,
	};
}

function validHash(hash: string | null | undefined): string | null {
	return typeof hash === "string" && HASH_RE.test(hash) ? hash : null;
}

function snowflakeDate(id: string): string {
	return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS)).toISOString();
}
