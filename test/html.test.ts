import { describe, expect, it } from "vitest";
import { buildMeta, safeJsonForScript, SECURITY_HEADERS } from "../src/html";
import type { GuildInfo, GuildSnapshot } from "../src/snapshot";

const SITE = "https://discord.nanako.org";
const SITE_NAME = "Nanako's Community";

const guild: GuildInfo = {
	description: "A cozy place.",
	iconUrl: "https://cdn.discordapp.com/icons/1/a.webp?size=256",
	ogImageUrl: "https://cdn.discordapp.com/icons/1/a.png?size=512",
	bannerUrl: null,
	brandColor: "#4fe2ca",
	tag: null,
	memberCount: 1310,
	onlineCount: 20,
	boostCount: 2,
	boostTier: 1,
	verificationLevel: 2,
	features: [],
	inviteChannel: "speak-here",
	games: [],
};

const snapshot: GuildSnapshot = {
	id: "1114391825336250432",
	name: "Nanako‘s Community",
	createdAt: "2023-06-03T03:15:15.559Z",
	inviteUrl: "https://discord.gg/XmuHsQYX",
	guild,
	widget: null,
	sources: { guild: "2026-10-20T12:00:00.000Z", widget: null },
	fetchedAt: "2026-10-20T12:00:00.000Z",
	stale: false,
};

describe("safeJsonForScript", () => {
	const hostile = "</script><img src=x onerror=alert(1)> & \u2028 \u2029";

	it("escapes characters that could break out of a <script> element", () => {
		const out = safeJsonForScript({ name: hostile });

		expect(out).not.toMatch(/[<>&\u2028\u2029]/);
		expect(JSON.parse(out)).toEqual({ name: hostile });
	});

	it("serializes null", () => {
		expect(safeJsonForScript(null)).toBe("null");
	});
});

describe("buildMeta", () => {
	it("builds share metadata with formatted counts", () => {
		expect(buildMeta(snapshot, SITE, SITE_NAME)).toEqual({
			title: "Nanako‘s Community | Discord",
			description: "1,310 位成员 · 20 人在线 — A cozy place.",
			image: "https://cdn.discordapp.com/icons/1/a.png?size=512",
			url: "https://discord.nanako.org/",
		});
	});

	it("uses the widget online count when guild info is missing", () => {
		const widgetOnly: GuildSnapshot = {
			...snapshot,
			guild: null,
			widget: { onlineCount: 7, members: [], voiceChannels: [] },
		};
		expect(buildMeta(widgetOnly, SITE, SITE_NAME)).toMatchObject({ description: "7 人在线", image: null });
	});

	it("truncates long descriptions without splitting surrogate pairs", () => {
		const meta = buildMeta({ ...snapshot, guild: { ...guild, description: "😀".repeat(300) } }, SITE, SITE_NAME);
		expect(Array.from(meta.description).length).toBeLessThanOrEqual(200);
		expect(meta.description.endsWith("…")).toBe(true);
		expect(meta.description).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
	});

	it("falls back to the site name without a snapshot", () => {
		expect(buildMeta(null, SITE, SITE_NAME)).toEqual({
			title: "Nanako's Community | Discord",
			description: "加入 Nanako's Community 的 Discord 服务器",
			image: null,
			url: "https://discord.nanako.org/",
		});
	});
});

describe("SECURITY_HEADERS", () => {
	it("restricts scripts to self and images to the Discord CDN", () => {
		const csp = SECURITY_HEADERS["Content-Security-Policy"];
		expect(csp).toContain("script-src 'self'");
		expect(csp).toContain("img-src 'self' https://cdn.discordapp.com data:");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
		expect(SECURITY_HEADERS["X-Frame-Options"]).toBe("DENY");
		expect(SECURITY_HEADERS["Strict-Transport-Security"]).toBe("max-age=31536000");
	});
});
