export interface AppConfig {
	guildId: string;
	/** Permanent invite code; null → use the widget's rotating instant invite. */
	inviteCode: string | null;
	/** Origin only, e.g. https://discord.nanako.org */
	siteUrl: string;
	/** Fallback display name when Discord data is unavailable. */
	siteName: string;
}

export class ConfigError extends Error {
	override name = "ConfigError";
}

const GUILD_ID_RE = /^\d{17,20}$/;
const INVITE_CODE_RE = /^[A-Za-z0-9-]{2,32}$/;
const DEFAULT_SITE_NAME = "Discord 服务器";
const MAX_SITE_NAME = 100;

interface RawEnv {
	GUILD_ID?: unknown;
	INVITE_CODE?: unknown;
	SITE_URL?: unknown;
	SITE_NAME?: unknown;
}

export function readConfig(env: RawEnv): AppConfig {
	const guildId = env.GUILD_ID;
	if (typeof guildId !== "string" || !GUILD_ID_RE.test(guildId)) {
		throw new ConfigError("GUILD_ID must be a quoted 17–20 digit Discord snowflake");
	}

	return {
		guildId,
		inviteCode: parseInviteCode(env.INVITE_CODE),
		siteUrl: parseSiteUrl(env.SITE_URL),
		siteName: parseSiteName(env.SITE_NAME),
	};
}

function parseInviteCode(value: unknown): string | null {
	if (value === undefined || value === "") return null;
	if (typeof value !== "string" || !INVITE_CODE_RE.test(value)) {
		throw new ConfigError("INVITE_CODE must be empty or 2–32 characters of A–Z, a–z, 0–9 or '-'");
	}
	return value;
}

function parseSiteUrl(value: unknown): string {
	let url: URL;
	try {
		url = new URL(String(value ?? ""));
	} catch {
		throw new ConfigError("SITE_URL must be an absolute URL");
	}
	if (url.protocol !== "https:") {
		throw new ConfigError("SITE_URL must use https");
	}
	return url.origin;
}

function parseSiteName(value: unknown): string {
	if (value === undefined || value === "") return DEFAULT_SITE_NAME;
	if (typeof value !== "string" || value.length > MAX_SITE_NAME) {
		throw new ConfigError(`SITE_NAME must be a string of at most ${MAX_SITE_NAME} characters`);
	}
	return value;
}
