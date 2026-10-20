import type { GuildSnapshot } from "./snapshot";

export interface PageMeta {
	title: string;
	description: string;
	image: string | null;
	url: string;
}

const MAX_DESCRIPTION = 200;
const formatCount = new Intl.NumberFormat("en-US").format;

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"Content-Security-Policy": [
		"default-src 'self'",
		"img-src 'self' https://cdn.discordapp.com data:",
		"script-src 'self'",
		"style-src 'self'",
		"connect-src 'self'",
		"frame-ancestors 'none'",
		"base-uri 'none'",
		"object-src 'none'",
		"form-action 'none'",
	].join("; "),
	"Strict-Transport-Security": "max-age=31536000",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

/**
 * JSON that is safe to place inside a <script type="application/json"> element:
 * no sequence can close the element or be reinterpreted by the HTML parser.
 */
export function safeJsonForScript(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

export function buildMeta(snapshot: GuildSnapshot | null, siteUrl: string, siteName: string): PageMeta {
	const url = `${siteUrl}/`;
	if (!snapshot) {
		return { title: `${siteName} | Discord`, description: `加入 ${siteName} 的 Discord 服务器`, image: null, url };
	}

	const members = snapshot.guild?.memberCount ?? null;
	const online = snapshot.guild?.onlineCount ?? snapshot.widget?.onlineCount ?? null;
	const counts = [
		members !== null ? `${formatCount(members)} 位成员` : null,
		online !== null ? `${formatCount(online)} 人在线` : null,
	]
		.filter(Boolean)
		.join(" · ");
	const description = [counts, snapshot.guild?.description].filter(Boolean).join(" — ");

	return {
		title: `${snapshot.name} | Discord`,
		description: truncate(description || `加入 ${snapshot.name} 的 Discord 服务器`, MAX_DESCRIPTION),
		image: snapshot.guild?.ogImageUrl ?? null,
		url,
	};
}

/** Truncates by code point so emoji are never split into lone surrogates. */
function truncate(text: string, max: number): string {
	const chars = Array.from(text);
	return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}
