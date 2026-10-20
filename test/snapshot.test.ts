import { describe, expect, it } from "vitest";
import type { DiscordApplication, DiscordInvite } from "../src/discord";
import { buildSnapshot, type StoredSnapshot } from "../src/snapshot";
import { CDN, config, data, GUILD_ID, invite, now, widget } from "./support/snapshot-data";

const withGuild = (guild: Partial<DiscordInvite["guild"]>, profile?: Record<string, unknown>): DiscordInvite => ({
	...invite,
	guild: { ...invite.guild, ...guild },
	profile: { ...invite.profile, ...profile },
});

describe("buildSnapshot: guild info", () => {
	it("maps everything the invite API exposes", () => {
		const s = buildSnapshot(data(), config, now);

		expect(s).toMatchObject({
			id: GUILD_ID,
			name: "Nanako‘s Community",
			createdAt: "2023-06-03T03:15:15.559Z",
			inviteUrl: "https://discord.gg/XmuHsQYX",
			rejectedInviteCode: null,
			sources: { guild: "2026-10-20T12:00:00.000Z", widget: "2026-10-20T12:00:00.000Z" },
			fetchedAt: "2026-10-20T12:00:00.000Z",
			stale: false,
		});
		expect(s.guild).toEqual({
			description: null,
			iconUrl: `${CDN}/icons/${GUILD_ID}/42e0892e057eccdf8f50765cef3fbfd8.webp?size=256`,
			ogImageUrl: `${CDN}/icons/${GUILD_ID}/42e0892e057eccdf8f50765cef3fbfd8.png?size=512`,
			bannerUrl: `${CDN}/splashes/${GUILD_ID}/a77ff53d4950ca8eec961cde606ba91f.webp?size=1024`,
			brandColor: "#4fe2ca",
			tag: null,
			memberCount: 131,
			onlineCount: 20,
			boostCount: 2,
			boostTier: 1,
			verificationLevel: 2,
			features: expect.arrayContaining(["COMMUNITY", "NEWS", "SOUNDBOARD"]),
			inviteChannel: "speak-here",
			games: [{ id: "700136079562375258", name: "VALORANT", iconUrl: `${CDN}/app-icons/700136079562375258/e55fc8259df1548328f977d302779ab7.webp?size=64` }],
		});
	});

	it("prefers the banner over the splash and animates a_ icons", () => {
		const s = buildSnapshot(data({ invite: withGuild({ icon: "a_abc123", banner: "ban456" }) }), config, now);
		expect(s.guild?.iconUrl).toBe(`${CDN}/icons/${GUILD_ID}/a_abc123.gif?size=256`);
		expect(s.guild?.bannerUrl).toBe(`${CDN}/banners/${GUILD_ID}/ban456.webp?size=1024`);
	});

	it("ignores image hashes that are not plain identifiers", () => {
		const s = buildSnapshot(data({ invite: withGuild({ icon: "../../evil?x=", banner: "a/b", splash: "c#d" }) }), config, now);
		expect([s.guild?.iconUrl, s.guild?.ogImageUrl, s.guild?.bannerUrl]).toEqual([null, null, null]);
	});

	it("validates brand color, tag and feature names", () => {
		const s = buildSnapshot(
			data({
				invite: withGuild(
					{ features: ["COMMUNITY", "<script>", 42 as unknown as string] },
					{ brand_color_primary: "red;}body{", tag: "<b>LONGER-THAN-ALLOWED</b>" },
				),
			}),
			config,
			now,
		);
		expect(s.guild?.brandColor).toBeNull();
		expect(s.guild?.tag).toBeNull();
		expect(s.guild?.features).toEqual(["COMMUNITY"]);
	});

	it("keeps a short server tag", () => {
		const s = buildSnapshot(data({ invite: withGuild({}, { tag: "NANA" }) }), config, now);
		expect(s.guild?.tag).toBe("NANA");
	});

	it("normalizes a blank description to null and keeps a real one trimmed", () => {
		expect(buildSnapshot(data({ invite: withGuild({ description: "   " }) }), config, now).guild?.description).toBeNull();
		expect(buildSnapshot(data({ invite: withGuild({ description: " hi " }) }), config, now).guild?.description).toBe("hi");
	});
});

describe("buildSnapshot: widget info", () => {
	it("maps members with voice state, dropping non-CDN avatars", () => {
		const members = buildSnapshot(data(), config, now).widget?.members ?? [];

		expect(members).toHaveLength(4);
		expect(members[0]).toEqual({
			name: "Alice",
			avatarUrl: `${CDN}/widget-avatars/aaa/bbb`,
			status: "online",
			activity: "Minecraft",
			voice: { muted: true, deafened: false },
		});
		expect(members[1]).toEqual({
			name: "</script><img src=x onerror=alert(1)>",
			avatarUrl: null,
			status: "dnd",
			activity: null,
			voice: null,
		});
		expect(members[3].voice).toEqual({ muted: true, deafened: false });
	});

	it("lists every voice channel by position, including empty ones", () => {
		const w = buildSnapshot(data(), config, now).widget;

		expect(w?.onlineCount).toBe(20);
		expect(w?.voiceChannels.map((c) => [c.name, c.members.map((m) => m.name)])).toEqual([
			["Room 1", ["Alice", "Carol"]],
			["Room 2", []],
			["Nanako's Room", ["Bob"]],
		]);
		expect(w?.voiceChannels[2].members[0].voice).toEqual({ muted: true, deafened: true });
	});

	it("does not mutate its inputs", () => {
		const widgetCopy = structuredClone(widget);
		const inviteCopy = structuredClone(invite);
		buildSnapshot(data(), config, now);
		expect(widget).toEqual(widgetCopy);
		expect(invite).toEqual(inviteCopy);
	});
});

describe("buildSnapshot: partial failures", () => {
	const previous = buildSnapshot(data(), config, new Date("2026-10-20T11:00:00.000Z"));

	it("falls back to widget data on a cold start without invite data", () => {
		const s = buildSnapshot(data({ invite: null, applications: [], failed: { invite: true, widget: false } }), config, now);

		expect(s.name).toBe("Nanako‘s Community");
		expect(s.guild).toBeNull();
		expect(s.widget?.onlineCount).toBe(20);
	});

	it("uses the configured site name when nothing provides a name", () => {
		const s = buildSnapshot(data({ invite: null, widget: null, failed: { invite: true, widget: false } }), config, now);
		expect(s.name).toBe("Nanako's Community");
	});

	it("keeps the previous guild info, and its age, when the invite request failed", () => {
		const s = buildSnapshot(data({ invite: null, failed: { invite: true, widget: false } }), config, now, previous);
		expect(s.guild).toEqual(previous.guild);
		expect(s.sources).toEqual({ guild: previous.sources.guild, widget: now.toISOString() });
		// The oldest part decides how old the snapshot is, so carried-over data ages honestly.
		expect(s.fetchedAt).toBe(previous.fetchedAt);
	});

	it("keeps the previous widget, and its age, when the widget request failed", () => {
		const s = buildSnapshot(data({ widget: null, failed: { invite: false, widget: true } }), config, now, previous);
		expect(s.widget).toEqual(previous.widget);
		expect(s.sources).toEqual({ guild: now.toISOString(), widget: previous.sources.widget });
		expect(s.fetchedAt).toBe(previous.fetchedAt);
	});

	it("keeps aging carried-over data across repeated partial failures", () => {
		const later = new Date("2026-10-20T13:00:00.000Z");
		const once = buildSnapshot(data({ invite: null, failed: { invite: true, widget: false } }), config, now, previous);
		const twice = buildSnapshot(data({ invite: null, failed: { invite: true, widget: false } }), config, later, once);
		expect(twice.sources).toEqual({ guild: previous.sources.guild, widget: later.toISOString() });
		expect(twice.fetchedAt).toBe(previous.fetchedAt);
	});

	it("has no source timestamp for a failed source without previous data", () => {
		const s = buildSnapshot(data({ invite: null, failed: { invite: true, widget: false } }), config, now);
		expect(s.sources).toEqual({ guild: null, widget: now.toISOString() });
		expect(s.fetchedAt).toBe(now.toISOString());
	});

	it("drops the widget (and its timestamp) when it was disabled rather than failing", () => {
		const s = buildSnapshot(data({ widget: null }), config, now, previous);
		expect(s.widget).toBeNull();
		expect(s.sources.widget).toBeNull();
	});

	it("uses the build time when no source provided data", () => {
		const s = buildSnapshot(data({ invite: null, widget: null, failed: { invite: true, widget: false } }), config, now);
		expect(s.sources).toEqual({ guild: null, widget: null });
		expect(s.fetchedAt).toBe(now.toISOString());
	});

	it("keeps the previous invite url when the widget request failed", () => {
		const prev: StoredSnapshot = { ...previous, inviteUrl: "https://discord.com/invite/OldCode" };
		const s = buildSnapshot(data({ widget: null, failed: { invite: false, widget: true } }), { ...config, inviteCode: null }, now, prev);
		expect(s.inviteUrl).toBe("https://discord.com/invite/OldCode");
	});

	it("does not resurrect the previous invite url when the widget answered without an instant invite", () => {
		const prev: StoredSnapshot = { ...previous, inviteUrl: "https://discord.com/invite/OldCode" };
		const s = buildSnapshot(data({ widget: { ...widget, instant_invite: null } }), { ...config, inviteCode: null }, now, prev);
		expect(s.inviteUrl).toBeNull();
	});

	it("does not resurrect the previous invite url when the widget was disabled", () => {
		const prev: StoredSnapshot = { ...previous, inviteUrl: "https://discord.com/invite/OldCode" };
		const s = buildSnapshot(data({ widget: null }), { ...config, inviteCode: null }, now, prev);
		expect(s.inviteUrl).toBeNull();
	});
});

describe("buildSnapshot: featured games", () => {
	const ids = ["700136079562375258", "700136079562375259", "700136079562375260"];
	const profileWith = (gameIds: string[]) => ({ ...invite, profile: { ...invite.profile, game_application_ids: gameIds } });
	const appFor = (id: string, name: string): DiscordApplication => ({ id, name, icon: null });
	const previous = buildSnapshot(
		data({ invite: profileWith(ids), applications: [appFor(ids[0], "A"), appFor(ids[1], "B"), appFor(ids[2], "C")] }),
		config,
		new Date("2026-10-20T11:00:00.000Z"),
	);

	it("keeps the cached game when its lookup failed, in profile order", () => {
		const s = buildSnapshot(
			data({ invite: profileWith(ids), applications: [appFor(ids[0], "A2"), appFor(ids[2], "C2")], failedApplicationIds: [ids[1]] }),
			config,
			now,
			previous,
		);
		expect(s.guild?.games.map((g) => [g.id, g.name])).toEqual([
			[ids[0], "A2"],
			[ids[1], "B"],
			[ids[2], "C2"],
		]);
	});

	it("omits a failed game that was never cached", () => {
		const s = buildSnapshot(
			data({ invite: profileWith(ids), applications: [appFor(ids[0], "A2")], failedApplicationIds: [ids[1]] }),
			config,
			now,
		);
		expect(s.guild?.games.map((g) => g.id)).toEqual([ids[0]]);
	});

	it("drops a game the server no longer features", () => {
		const s = buildSnapshot(data({ invite: profileWith([ids[0]]), applications: [appFor(ids[0], "A2")] }), config, now, previous);
		expect(s.guild?.games.map((g) => g.id)).toEqual([ids[0]]);
	});
});
