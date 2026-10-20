import { describe, expect, it } from "vitest";
import type { DiscordData, DiscordWidget } from "../src/discord";
import { buildSnapshot } from "../src/snapshot";
import { config, data, GUILD_ID, now, widget } from "./support/snapshot-data";

describe("buildSnapshot: invite url", () => {
	it("uses the widget's instant invite when no code is configured", () => {
		const s = buildSnapshot(data(), { ...config, inviteCode: null }, now);
		expect(s.inviteUrl).toBe("https://discord.com/invite/XmuHsQYX");
	});

	it.each(["javascript:alert(1)", "https://evil.example/invite/x", "https://discord.com/invite/x?y=<z>"])(
		"ignores a widget instant invite that is not a plain Discord invite url: %s",
		(instant_invite) => {
			const s = buildSnapshot(data({ widget: { ...widget, instant_invite } }), { ...config, inviteCode: null }, now);
			expect(s.inviteUrl).toBeNull();
		},
	);
});

describe("buildSnapshot: invite for another guild", () => {
	const rejected = (overrides: Partial<DiscordData> = {}) =>
		data({ invite: null, applications: [], failed: { invite: true, widget: false }, inviteRejected: true, ...overrides });
	const previous = buildSnapshot(data(), config, new Date("2026-10-20T11:00:00.000Z"));

	it("never advertises a configured code that resolves to a different guild (in any url form)", () => {
		// The fixture widget's instant invite carries the very code that was rejected.
		expect(widget.instant_invite).toBe("https://discord.com/invite/XmuHsQYX");
		const s = buildSnapshot(rejected(), config, now, previous);
		expect(s.inviteUrl).toBeNull();
	});

	it("uses the widget's own instant invite instead of the rejected configured code", () => {
		const s = buildSnapshot(rejected({ widget: { ...widget, instant_invite: "https://discord.com/invite/Widget1" } }), config, now);
		expect(s.inviteUrl).toBe("https://discord.com/invite/Widget1");
	});

	it("has no join link when the widget has no valid instant invite either", () => {
		const s = buildSnapshot(rejected({ widget: { ...widget, instant_invite: "javascript:alert(1)" } }), config, now, previous);
		expect(s.inviteUrl).toBeNull();
	});

	it("does not fall back to a previous invite url carrying the rejected code, even when the widget failed", () => {
		const s = buildSnapshot(rejected({ widget: null, failed: { invite: true, widget: true } }), config, now, previous);
		expect(previous.inviteUrl).toBe("https://discord.gg/XmuHsQYX");
		expect(s.inviteUrl).toBeNull();
	});

	it("builds a link-less snapshot from the verdict alone when nothing else is available", () => {
		const s = buildSnapshot(rejected({ widget: null, failed: { invite: true, widget: true } }), config, now);
		expect(s).toEqual({
			id: GUILD_ID,
			name: config.siteName,
			createdAt: "2023-06-03T03:15:15.559Z",
			inviteUrl: null,
			rejectedInviteCode: "XmuHsQYX",
			guild: null,
			widget: null,
			sources: { guild: null, widget: null },
			fetchedAt: now.toISOString(),
			stale: false,
		});
	});

	it("keeps cached guild info (with its own age) but drops its invite url when the widget is disabled", () => {
		const s = buildSnapshot(rejected({ widget: null }), config, now, previous);
		expect(s.inviteUrl).toBeNull();
		expect(s.guild).toEqual(previous.guild);
		expect(s.sources).toEqual({ guild: previous.sources.guild, widget: null });
		expect(s.fetchedAt).toBe(previous.sources.guild);
	});

	it("without a configured code, distrusts the widget invite that was itself rejected", () => {
		const s = buildSnapshot(rejected(), { ...config, inviteCode: null }, now, previous);
		expect(s.inviteUrl).toBeNull();
	});
});

describe("buildSnapshot: the rejection verdict is sticky", () => {
	const OTHER = "OTHER";
	const otherConfig = { ...config, inviteCode: OTHER };
	const instant = (code: string | null): DiscordWidget => ({
		...widget,
		instant_invite: code === null ? null : `https://discord.com/invite/${code}`,
	});
	const rejectedBy = (w: DiscordWidget | null, failedWidget = false): DiscordData =>
		data({
			invite: null,
			widget: w,
			applications: [],
			failed: { invite: true, widget: failedWidget },
			inviteCode: OTHER,
			inviteRejected: true,
		});
	/** The invite API failed for an unrelated reason (429, 5xx, timeout): no verdict either way. */
	const inviteDown = (w: DiscordWidget | null, failedWidget = false): DiscordData =>
		data({ invite: null, widget: w, applications: [], failed: { invite: true, widget: failedWidget }, inviteCode: OTHER });
	const later = new Date("2026-10-20T13:00:00.000Z");

	it("records the rejected code", () => {
		const s = buildSnapshot(rejectedBy(instant(null)), otherConfig, now);
		expect(s.rejectedInviteCode).toBe(OTHER);
		expect(s.inviteUrl).toBeNull();
	});

	it("keeps withholding the configured code while later lookups fail for unrelated reasons", () => {
		const rejected = buildSnapshot(rejectedBy(instant(null)), otherConfig, now);
		const once = buildSnapshot(inviteDown(instant(null)), otherConfig, later, rejected);
		const twice = buildSnapshot(inviteDown(instant(null)), otherConfig, later, once);

		for (const s of [once, twice]) {
			expect(s.inviteUrl).toBeNull();
			expect(s.rejectedInviteCode).toBe(OTHER);
		}
	});

	it("keeps offering the widget's own invite, never the rejected code, while the verdict stands", () => {
		const rejected = buildSnapshot(rejectedBy(instant("Widget1")), otherConfig, now);
		expect(rejected.inviteUrl).toBe("https://discord.com/invite/Widget1");

		const s = buildSnapshot(inviteDown(instant("Widget2")), otherConfig, later, rejected);
		expect(s.inviteUrl).toBe("https://discord.com/invite/Widget2");
	});

	it("keeps the previous widget invite when the widget fails as well", () => {
		const rejected = buildSnapshot(rejectedBy(instant("Widget1")), otherConfig, now);
		const s = buildSnapshot(inviteDown(null, true), otherConfig, later, rejected);
		expect(s.inviteUrl).toBe("https://discord.com/invite/Widget1");
	});

	it("never offers a widget invite that carries the rejected code", () => {
		const rejected = buildSnapshot(rejectedBy(instant(null)), otherConfig, now);
		const s = buildSnapshot(inviteDown(instant(OTHER)), otherConfig, later, rejected);
		expect(s.inviteUrl).toBeNull();
	});

	it("lifts the verdict once a lookup of that very code matches this guild again", () => {
		const rejected = buildSnapshot(rejectedBy(instant(null)), otherConfig, now);
		const s = buildSnapshot(data({ inviteCode: OTHER }), otherConfig, later, rejected);
		expect(s.rejectedInviteCode).toBeNull();
		expect(s.inviteUrl).toBe(`https://discord.gg/${OTHER}`);
	});

	it("keeps the verdict when a different code is verified (no configured code)", () => {
		const unconfigured = { ...config, inviteCode: null };
		const rejected = buildSnapshot(rejectedBy(instant(OTHER)), unconfigured, now);
		const verified = buildSnapshot(data({ widget: instant("Fresh1"), inviteCode: "Fresh1" }), unconfigured, later, rejected);
		expect(verified.inviteUrl).toBe("https://discord.com/invite/Fresh1");
		expect(verified.rejectedInviteCode).toBe(OTHER);

		const s = buildSnapshot(inviteDown(instant(OTHER)), unconfigured, later, verified);
		expect(s.inviteUrl).toBeNull();
	});
});
