import type { DiscordApplication, DiscordData, DiscordInvite, DiscordWidget } from "../../src/discord";
import applicationFixture from "../fixtures/application.json";
import inviteFixture from "../fixtures/invite.json";
import widgetFixture from "../fixtures/widget.json";

/** Shared inputs for the buildSnapshot tests. */
export const invite = inviteFixture as unknown as DiscordInvite;
export const widget = widgetFixture as unknown as DiscordWidget;
export const app: DiscordApplication = { id: applicationFixture.id, name: applicationFixture.name, icon: applicationFixture.icon };

export const GUILD_ID = "1114391825336250432";
export const config = { guildId: GUILD_ID, inviteCode: "XmuHsQYX", siteName: "Nanako's Community" };
export const now = new Date("2026-10-20T12:00:00.000Z");
export const CDN = "https://cdn.discordapp.com";

/** A fully successful fetch of the configured code, with per-test overrides. */
export const data = (overrides: Partial<DiscordData> = {}): DiscordData => ({
	invite,
	widget,
	applications: [app],
	failedApplicationIds: [],
	failed: { invite: false, widget: false },
	inviteCode: "XmuHsQYX",
	inviteRejected: false,
	...overrides,
});
