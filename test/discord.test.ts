import { describe, expect, it, vi } from "vitest";
import {
	DiscordApiError,
	fetchApplication,
	fetchDiscordData,
	fetchInvite,
	fetchWidget,
	inviteCodeFrom,
	InviteGuildMismatchError,
	REQUEST_TIMEOUT_MS,
	type Fetcher,
} from "../src/discord";
import application from "./fixtures/application.json";
import invite from "./fixtures/invite.json";
import widget from "./fixtures/widget.json";

const GUILD_ID = "1114391825336250432";
const withCode = { guildId: GUILD_ID, inviteCode: "XmuHsQYX" };
const withoutCode = { guildId: GUILD_ID, inviteCode: null };

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const widgetDisabled = () => json({ message: "Widget Disabled", code: 50004 }, 403);

type Route = () => Response | Promise<Response>;

function routeFetcher(routes: { invite?: Route; widget?: Route; application?: Route }) {
	return vi.fn<Fetcher>(async (url) => {
		if (url.includes("/invites/")) return routes.invite ? routes.invite() : json({}, 500);
		if (url.includes("/widget.json")) return routes.widget ? routes.widget() : json({}, 500);
		if (url.includes("/applications/")) return routes.application ? routes.application() : json({}, 404);
		throw new Error(`unexpected url ${url}`);
	});
}

const allOk = () => routeFetcher({ invite: () => json(invite), widget: () => json(widget), application: () => json(application) });

describe("short rate-limit retries", () => {
	const rateLimited = (retryAfterSeconds: number) =>
		json({ message: "You are being rate limited.", retry_after: retryAfterSeconds, global: false }, 429);

	it("retries a 429 after the advertised short wait and succeeds", async () => {
		const responses = [rateLimited(0.01), rateLimited(0.01), json(invite)];
		const fetcher = routeFetcher({ invite: () => responses.shift() ?? json({}, 500) });

		await expect(fetchInvite("XmuHsQYX", fetcher)).resolves.toMatchObject({ code: "XmuHsQYX" });
		expect(fetcher).toHaveBeenCalledTimes(3);
	});

	it("gives up after two retries", async () => {
		const fetcher = routeFetcher({ invite: () => rateLimited(0.01) });
		await expect(fetchInvite("XmuHsQYX", fetcher)).rejects.toMatchObject({ status: 429 });
		expect(fetcher).toHaveBeenCalledTimes(3);
	});

	it("does not wait out a long rate limit", async () => {
		const fetcher = routeFetcher({ invite: () => rateLimited(30) });
		await expect(fetchInvite("XmuHsQYX", fetcher)).rejects.toMatchObject({ status: 429 });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("retries a short global rate limit too (shared egress IPs hit it)", async () => {
		const responses = [json({ message: "You are being rate limited.", retry_after: 0.01, global: true }, 429), json(invite)];
		const fetcher = routeFetcher({ invite: () => responses.shift() ?? json({}, 500) });
		await expect(fetchInvite("XmuHsQYX", fetcher)).resolves.toMatchObject({ code: "XmuHsQYX" });
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("prefers the body's retry_after over a contradictory Retry-After header", async () => {
		const limited = () =>
			new Response(JSON.stringify({ message: "You are being rate limited.", retry_after: 0.01, global: true }), {
				status: 429,
				headers: { "Retry-After": "300", "Content-Type": "application/json" },
			});
		const responses = [limited(), json(widget)];
		const fetcher = routeFetcher({ widget: () => responses.shift() ?? json({}, 500) });
		await expect(fetchWidget(GUILD_ID, fetcher)).resolves.toMatchObject({ presence_count: 20 });
	});

	it("also retries the widget request", async () => {
		const responses = [rateLimited(0.01), json(widget)];
		const fetcher = routeFetcher({ widget: () => responses.shift() ?? json({}, 500) });
		await expect(fetchWidget(GUILD_ID, fetcher)).resolves.toMatchObject({ presence_count: 20 });
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});

describe("fetchInvite", () => {
	it("requests counts for the encoded invite code with a timeout and user agent", async () => {
		const fetcher = routeFetcher({ invite: () => json(invite) });
		const result = await fetchInvite("XmuHsQYX", fetcher);

		expect(result.guild.name).toBe("Nanako‘s Community");
		const [url, init] = fetcher.mock.calls[0];
		expect(url).toBe("https://discord.com/api/v10/invites/XmuHsQYX?with_counts=true");
		expect(new Headers(init?.headers).get("User-Agent")).toMatch(/discord-share/);
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(init?.redirect).toBe("manual");
	});

	it("throws DiscordApiError with the status on HTTP failure", async () => {
		const fetcher = routeFetcher({ invite: () => json({ message: "Unknown Invite", code: 10006 }, 404) });
		await expect(fetchInvite("gone", fetcher)).rejects.toMatchObject({ name: "DiscordApiError", status: 404 });
	});

	it("rejects payloads without a guild object", async () => {
		const fetcher = routeFetcher({ invite: () => json({ code: "x" }) });
		await expect(fetchInvite("x", fetcher)).rejects.toBeInstanceOf(DiscordApiError);
	});
});

describe("fetchWidget", () => {
	it("returns the widget payload", async () => {
		const fetcher = routeFetcher({ widget: () => json(widget) });
		const result = await fetchWidget(GUILD_ID, fetcher);
		expect(result?.members).toHaveLength(4);
		expect(fetcher.mock.calls[0][0]).toBe(`https://discord.com/api/guilds/${GUILD_ID}/widget.json`);
	});

	it("returns null when the widget is disabled (403 / 50004)", async () => {
		await expect(fetchWidget(GUILD_ID, routeFetcher({ widget: widgetDisabled }))).resolves.toBeNull();
	});

	it("throws for other 403 responses", async () => {
		const fetcher = routeFetcher({ widget: () => json({ message: "Missing Access", code: 50001 }, 403) });
		await expect(fetchWidget(GUILD_ID, fetcher)).rejects.toMatchObject({ status: 403 });
	});

	it("throws for 429 rate limits", async () => {
		const fetcher = routeFetcher({ widget: () => json({ message: "rate limited" }, 429) });
		await expect(fetchWidget(GUILD_ID, fetcher)).rejects.toMatchObject({ status: 429 });
	});

	it("includes rate-limit details and a bounded body excerpt in the error message", async () => {
		const body = { message: "You are being rate limited.", retry_after: 3.5, global: true, pad: "x".repeat(1000) };
		const fetcher = routeFetcher({
			widget: () =>
				new Response(JSON.stringify(body), {
					status: 429,
					headers: { "Retry-After": "4", "X-RateLimit-Scope": "shared", "Content-Type": "application/json" },
				}),
		});
		const error = await fetchWidget(GUILD_ID, fetcher).then(
			() => {
				throw new Error("expected a rejection");
			},
			(e: unknown) => e as Error,
		);
		expect(error.message).toMatch(/HTTP 429/);
		expect(error.message).toMatch(/retry-after=4/);
		expect(error.message).toMatch(/scope=shared/);
		expect(error.message).toMatch(/You are being rate limited/);
		expect(error.message.length).toBeLessThan(400);
	});

	it("rejects payloads without member/channel arrays", async () => {
		const fetcher = routeFetcher({ widget: () => json({ id: GUILD_ID, members: "nope" }) });
		await expect(fetchWidget(GUILD_ID, fetcher)).rejects.toBeInstanceOf(DiscordApiError);
	});
});

describe("fetchApplication", () => {
	it("returns the public application name and icon", async () => {
		const fetcher = routeFetcher({ application: () => json(application) });
		await expect(fetchApplication("700136079562375258", fetcher)).resolves.toEqual({
			id: "700136079562375258",
			name: "VALORANT",
			icon: "e55fc8259df1548328f977d302779ab7",
		});
		expect(fetcher.mock.calls[0][0]).toBe("https://discord.com/api/v10/applications/700136079562375258/rpc");
	});

	it("rejects payloads without a name", async () => {
		const fetcher = routeFetcher({ application: () => json({ id: "1" }) });
		await expect(fetchApplication("700136079562375258", fetcher)).rejects.toBeInstanceOf(DiscordApiError);
	});
});

describe("fetchDiscordData", () => {
	it("returns invite, widget and game applications when everything succeeds", async () => {
		const data = await fetchDiscordData(withCode, allOk());

		expect(data.invite?.guild.id).toBe(GUILD_ID);
		expect(data.widget?.presence_count).toBe(20);
		expect(data.applications.map((a) => a.name)).toEqual(["VALORANT"]);
		expect(data.failedApplicationIds).toEqual([]);
		expect(data.failed).toEqual({ invite: false, widget: false });
		expect(data.inviteRejected).toBe(false);
	});

	it("derives the invite code from the widget when none is configured", async () => {
		const fetcher = allOk();
		const data = await fetchDiscordData(withoutCode, fetcher);

		expect(data.invite?.code).toBe("XmuHsQYX");
		expect(fetcher.mock.calls.map(([url]) => url)).toContain(
			"https://discord.com/api/v10/invites/XmuHsQYX?with_counts=true",
		);
	});

	it("throws when no invite is configured and the widget is disabled", async () => {
		const fetcher = routeFetcher({ invite: () => json(invite), widget: widgetDisabled });
		await expect(fetchDiscordData(withoutCode, fetcher)).rejects.toBeInstanceOf(DiscordApiError);
	});

	it("rejects an invite that belongs to a different guild", async () => {
		const foreign = { ...invite, guild: { ...invite.guild, id: "999999999999999999" } };
		const fetcher = routeFetcher({ invite: () => json(foreign), widget: () => json(widget) });
		const data = await fetchDiscordData(withCode, fetcher);

		expect(data.invite).toBeNull();
		expect(data.failed.invite).toBe(true);
		expect(data.inviteRejected).toBe(true);
		expect(data.inviteCode).toBe("XmuHsQYX");
	});

	it.each([
		["disabled", widgetDisabled],
		["failing", () => json({}, 503)],
	])("returns the rejection verdict instead of throwing when the widget is %s", async (_label, widgetRoute) => {
		// Throwing would leave nothing cached that says "this code is not ours", so the
		// configured link would keep being offered as the no-data fallback.
		const foreign = { ...invite, guild: { ...invite.guild, id: "999999999999999999" } };
		const onWarn = vi.fn();
		const data = await fetchDiscordData(withCode, routeFetcher({ invite: () => json(foreign), widget: widgetRoute }), { onWarn });

		expect(data).toMatchObject({ invite: null, widget: null, applications: [], inviteRejected: true });
		expect(data.failed.invite).toBe(true);
		expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/another guild/), expect.any(InviteGuildMismatchError));
	});

	it("does not report an ordinary invite failure as a rejection", async () => {
		const fetcher = routeFetcher({ invite: () => json({}, 404), widget: () => json(widget) });
		const data = await fetchDiscordData(withCode, fetcher);
		expect(data.inviteRejected).toBe(false);
	});

	it("reports a disabled widget as null without counting it as a failure", async () => {
		const fetcher = routeFetcher({ invite: () => json(invite), widget: widgetDisabled });
		const data = await fetchDiscordData(withCode, fetcher);
		expect(data.widget).toBeNull();
		expect(data.failed).toEqual({ invite: false, widget: false });
	});

	it("flags a widget outage separately from a disabled widget", async () => {
		const fetcher = routeFetcher({ invite: () => json(invite), widget: () => json({}, 503) });
		const data = await fetchDiscordData(withCode, fetcher);
		expect(data.widget).toBeNull();
		expect(data.failed).toEqual({ invite: false, widget: true });
	});

	it("keeps the widget when the invite fails", async () => {
		const fetcher = routeFetcher({ invite: () => json({}, 404), widget: () => json(widget) });
		const data = await fetchDiscordData(withCode, fetcher);
		expect(data.invite).toBeNull();
		expect(data.widget).not.toBeNull();
		expect(data.failed).toEqual({ invite: true, widget: false });
	});

	it("does not fail the whole fetch on game application lookup failures, but reports and warns", async () => {
		const fetcher = routeFetcher({ invite: () => json(invite), widget: () => json(widget), application: () => json({}, 404) });
		const onWarn = vi.fn();
		const data = await fetchDiscordData(withCode, fetcher, { onWarn });
		expect(data.applications).toEqual([]);
		expect(data.failedApplicationIds).toEqual(["700136079562375258"]);
		expect(data.failed).toEqual({ invite: false, widget: false });
		expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("700136079562375258"), expect.any(DiscordApiError));
	});

	it("warns about a partial invite failure that is otherwise absorbed by the widget", async () => {
		const fetcher = routeFetcher({ invite: () => json({}, 404), widget: () => json(widget) });
		const onWarn = vi.fn();
		await fetchDiscordData(withCode, fetcher, { onWarn });
		expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/invite/i), expect.objectContaining({ status: 404 }));
	});

	it("warns about a partial widget failure that is otherwise absorbed by the invite", async () => {
		const fetcher = routeFetcher({ invite: () => json(invite), widget: () => json({}, 503), application: () => json(application) });
		const onWarn = vi.fn();
		await fetchDiscordData(withCode, fetcher, { onWarn });
		expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/widget/i), expect.objectContaining({ status: 503 }));
	});

	it("does not warn when everything succeeds or the widget is merely disabled", async () => {
		const onWarn = vi.fn();
		await fetchDiscordData(withCode, allOk(), { onWarn });
		await fetchDiscordData(withCode, routeFetcher({ invite: () => json(invite), widget: widgetDisabled, application: () => json(application) }), {
			onWarn,
		});
		expect(onWarn).not.toHaveBeenCalled();
	});

	it("looks up at most three valid game application ids", async () => {
		const ids = ["1", "700136079562375258", "700136079562375259", "700136079562375260", "700136079562375261"];
		const many = { ...invite, profile: { ...invite.profile, game_application_ids: ids } };
		const fetcher = routeFetcher({ invite: () => json(many), widget: () => json(widget), application: () => json(application) });
		await fetchDiscordData(withCode, fetcher);

		const appCalls = fetcher.mock.calls.filter(([url]) => url.includes("/applications/"));
		expect(appCalls).toHaveLength(3);
	});

	it("falls back to the previous invite code when none is configured and the widget fails", async () => {
		const fetcher = routeFetcher({ invite: () => json(invite), widget: () => json({}, 503), application: () => json(application) });
		const data = await fetchDiscordData(withoutCode, fetcher, { fallbackInviteCode: "Prev123" });

		expect(data.invite?.guild.id).toBe(GUILD_ID);
		expect(data.failed).toEqual({ invite: false, widget: true });
		expect(fetcher.mock.calls.map(([url]) => url)).toContain("https://discord.com/api/v10/invites/Prev123?with_counts=true");
	});

	it("falls back to the previous invite code when the widget is disabled", async () => {
		const fetcher = routeFetcher({ invite: () => json(invite), widget: widgetDisabled, application: () => json(application) });
		const data = await fetchDiscordData(withoutCode, fetcher, { fallbackInviteCode: "Prev123" });
		expect(data.invite).not.toBeNull();
	});

	it("prefers the configured code and then the widget's code over the fallback", async () => {
		const configured = allOk();
		await fetchDiscordData(withCode, configured, { fallbackInviteCode: "Prev123" });
		const fromWidget = allOk();
		await fetchDiscordData(withoutCode, fromWidget, { fallbackInviteCode: "Prev123" });

		for (const fetcher of [configured, fromWidget]) {
			const urls = fetcher.mock.calls.map(([url]) => url);
			expect(urls).toContain("https://discord.com/api/v10/invites/XmuHsQYX?with_counts=true");
			expect(urls.some((url) => url.includes("Prev123"))).toBe(false);
		}
	});

	it("reports which invite code was looked up: configured, the widget's, then the fallback", async () => {
		const configured = await fetchDiscordData(withCode, allOk());
		const fromWidget = await fetchDiscordData(withoutCode, allOk());
		const fallback = await fetchDiscordData(
			withoutCode,
			routeFetcher({ invite: () => json(invite), widget: widgetDisabled, application: () => json(application) }),
			{ fallbackInviteCode: "Prev123" },
		);
		expect([configured.inviteCode, fromWidget.inviteCode, fallback.inviteCode]).toEqual(["XmuHsQYX", "XmuHsQYX", "Prev123"]);
	});

	it("reports the looked-up code even when its lookup failed for an unrelated reason", async () => {
		const fetcher = routeFetcher({ invite: () => json({ message: "You are being rate limited." }, 429), widget: () => json(widget) });
		const data = await fetchDiscordData(withCode, fetcher);
		expect(data).toMatchObject({ invite: null, inviteCode: "XmuHsQYX", inviteRejected: false });
	});

	it("reports no code when there was none to look up", async () => {
		const fetcher = routeFetcher({ widget: () => json({ ...widget, instant_invite: null }) });
		const data = await fetchDiscordData(withoutCode, fetcher);
		expect(data).toMatchObject({ invite: null, inviteCode: null, inviteRejected: false });
		expect(fetcher.mock.calls.some(([url]) => url.includes("/invites/"))).toBe(false);
	});

	it("still fails the invite when there is no code anywhere", async () => {
		const fetcher = routeFetcher({ invite: () => json(invite), widget: () => json({}, 503) });
		await expect(fetchDiscordData(withoutCode, fetcher, { fallbackInviteCode: null })).rejects.toThrow(/No invite code/);
	});

	it("throws when the invite fails and the widget is disabled", async () => {
		const fetcher = routeFetcher({ invite: () => json({}, 404), widget: widgetDisabled });
		await expect(fetchDiscordData(withCode, fetcher)).rejects.toBeInstanceOf(DiscordApiError);
	});

	it("throws when both requests fail (e.g. network errors)", async () => {
		const fetcher = vi.fn<Fetcher>(async () => {
			throw new TypeError("network down");
		});
		await expect(fetchDiscordData(withCode, fetcher)).rejects.toBeInstanceOf(DiscordApiError);
	});
});

describe("inviteCodeFrom", () => {
	it.each([
		["https://discord.gg/XmuHsQYX", "XmuHsQYX"],
		["https://discord.com/invite/abc-1", "abc-1"],
		["https://evil.example/invite/x", null],
		["https://discord.gg/x?y=1", null],
		[null, null],
		[undefined, null],
	])("extracts the code from %s", (url, code) => {
		expect(inviteCodeFrom(url)).toBe(code);
	});
});

describe("REQUEST_TIMEOUT_MS", () => {
	it("bounds each Discord request", () => {
		expect(REQUEST_TIMEOUT_MS).toBe(5_000);
	});
});
