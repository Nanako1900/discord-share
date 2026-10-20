import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRESH_MS, LOADING_WAIT_MS } from "../src/cache";
import application from "./fixtures/application.json";
import invite from "./fixtures/invite.json";
import widget from "./fixtures/widget.json";

const GUILD_ID = "1114391825336250432";
const SITE_URL = "https://discord.nanako.org";
const FOREIGN_GUILD = "999999999999999999";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const widgetDisabled = () => json({ message: "Widget Disabled", code: 50004 }, 403);
const never = () => new Promise<Response>(() => undefined);

type Route = () => Response | Promise<Response>;
interface DiscordRoutes {
	invite?: Route;
	widget?: Route;
	application?: Route;
}

function discordFetch(routes: DiscordRoutes) {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("/invites/")) return (routes.invite ?? (() => json({}, 500)))();
		if (url.includes("/widget.json")) return (routes.widget ?? (() => json({}, 500)))();
		if (url.includes("/applications/")) return (routes.application ?? (() => json({}, 404)))();
		throw new Error(`unexpected url ${url}`);
	});
}

/** Cache API stand-in: bodies are kept as text so every match() returns a fresh Response. */
class MemoryCache {
	readonly bodies = new Map<string, string>();
	async match(key: string): Promise<Response | undefined> {
		const body = this.bodies.get(key);
		return body === undefined ? undefined : new Response(body);
	}
	async put(key: string, res: Response): Promise<void> {
		this.bodies.set(key, await res.text());
	}
}

type Op = [selector: string, method: string, ...args: unknown[]];
interface ElementHandler {
	element(el: unknown): void;
}

/** HTMLRewriter stand-in that records which element edits the Worker asked for. */
class RecordingRewriter {
	static ops: Op[] = [];
	private readonly handlers: Array<[string, ElementHandler]> = [];
	on(selector: string, handler: ElementHandler): this {
		this.handlers.push([selector, handler]);
		return this;
	}
	transform(res: Response): Response {
		for (const [selector, handler] of this.handlers) {
			const record =
				(method: string) =>
				(...args: unknown[]) =>
					RecordingRewriter.ops.push([selector, method, ...args]);
			handler.element({
				setAttribute: record("setAttribute"),
				removeAttribute: record("removeAttribute"),
				setInnerContent: record("setInnerContent"),
				remove: record("remove"),
			});
		}
		return res;
	}
}

type Worker = (typeof import("../src/index"))["default"];

let worker: Worker;
let pending: Promise<unknown>[] = [];
let ctx: ExecutionContext;
let cache: MemoryCache;
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	// A fresh module per test is a fresh isolate: no in-flight load carries over.
	vi.resetModules();
	worker = (await import("../src/index")).default;
	vi.useFakeTimers();
	pending = [];
	RecordingRewriter.ops = [];
	ctx = { waitUntil: vi.fn((p: Promise<unknown>) => pending.push(p)), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;
	cache = new MemoryCache();
	vi.stubGlobal("caches", { default: cache });
	vi.stubGlobal("HTMLRewriter", RecordingRewriter);
	errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function envWith(inviteCode: string): Env {
	return {
		GUILD_ID,
		INVITE_CODE: inviteCode,
		SITE_URL,
		SITE_NAME: "Nanako's Community",
		ASSETS: { fetch: vi.fn(async () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } })) },
	} as unknown as Env;
}

type WorkerRequest = Parameters<Worker["fetch"]>[0];
const get = (path: string, env: Env) => worker.fetch(new Request(`${SITE_URL}${path}`) as WorkerRequest, env, ctx);
/** Runs every waitUntil chain to completion, including the checks that follow a cache write. */
async function settle(): Promise<void> {
	await vi.advanceTimersByTimeAsync(5_000);
	await Promise.all(pending);
}
const joinHref = () => RecordingRewriter.ops.find(([selector, method]) => selector === "a#join" && method === "setAttribute");

describe("GET /api/guild", () => {
	it("registers the cold-start refresh with waitUntil and answers 200 with the snapshot", async () => {
		vi.stubGlobal("fetch", discordFetch({ invite: () => json(invite), widget: () => json(widget), application: () => json(application) }));

		const res = await get("/api/guild", envWith(""));
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({ success: true, data: { id: GUILD_ID } });
		expect(ctx.waitUntil).toHaveBeenCalled();
		await settle();
	});

	it("logs a cold-start failure exactly once and answers 502", async () => {
		vi.stubGlobal("fetch", discordFetch({}));

		const res = await get("/api/guild", envWith("XmuHsQYX"));
		await settle();
		expect(res.status).toBe(502);
		expect(errors).toHaveBeenCalledTimes(1);
	});

	it("waits for another request's cold load and answers 503 + Retry-After only once the wait budget is spent", async () => {
		vi.stubGlobal("fetch", discordFetch({ invite: never, widget: never }));
		const env = envWith("XmuHsQYX");

		void get("/api/guild", env); // holds the cold-start lease, Discord never answers
		await vi.advanceTimersByTimeAsync(0);
		const second = get("/api/guild", env);
		await vi.advanceTimersByTimeAsync(LOADING_WAIT_MS);

		const res = await second;
		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBe("2");
		await expect(res.json()).resolves.toEqual({ success: false, data: null, error: "正在加载 Discord 数据" });
		expect(errors).not.toHaveBeenCalled();
	});
});

describe("GET /api/guild (one load per isolate)", () => {
	it("coalesces concurrent cold requests into a single Discord load", async () => {
		const later = (body: unknown) => () => new Promise<Response>((resolve) => setTimeout(() => resolve(json(body)), 20));
		const fetchMock = discordFetch({ invite: later(invite), widget: later(widget), application: later(application) });
		vi.stubGlobal("fetch", fetchMock);
		const env = envWith("XmuHsQYX");

		const responses = Promise.all(Array.from({ length: 10 }, () => get("/api/guild", env)));
		await vi.advanceTimersByTimeAsync(100);
		for (const res of await responses) expect(res.status).toBe(200);

		const calls = (part: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(part)).length;
		expect(calls("/widget.json")).toBe(1);
		expect(calls("/invites/")).toBe(1);
		await settle();
		expect(errors).not.toHaveBeenCalled();
	});
});

describe("foreign invite code", () => {
	it("is never published — neither in the API body nor in the page's initial data — yet stays withheld", async () => {
		const foreign = { ...invite, guild: { ...invite.guild, id: FOREIGN_GUILD } };
		vi.stubGlobal("fetch", discordFetch({ invite: () => json(foreign), widget: widgetDisabled }));
		const env = envWith("PrivateStaff");

		for (let i = 0; i < 2; i++) {
			// First a cold load, then served from the cache.
			const api = await get("/api/guild", env);
			const body = await api.text();
			expect(api.status).toBe(200);
			expect(body).toContain('"inviteUrl":null');
			expect(body).not.toContain("PrivateStaff");

			RecordingRewriter.ops = [];
			await get("/", env);
			expect(RecordingRewriter.ops.some(([selector]) => selector === "script#initial-data")).toBe(true);
			expect(JSON.stringify(RecordingRewriter.ops)).not.toContain("PrivateStaff");
			expect(joinHref()).toBeUndefined();
			await settle();
		}
		// The verdict is kept internally, so a later failing lookup cannot re-advertise the code.
		expect([...cache.bodies.values()].join()).toContain('"rejectedInviteCode":"PrivateStaff"');
	});
});

describe("GET / (join link)", () => {
	it("never links to a configured invite that belongs to another guild — first render and every render after", async () => {
		const foreign = { ...invite, guild: { ...invite.guild, id: FOREIGN_GUILD } };
		vi.stubGlobal("fetch", discordFetch({ invite: () => json(foreign), widget: widgetDisabled }));
		const env = envWith("OTHER");

		for (let i = 0; i < 2; i++) {
			RecordingRewriter.ops = [];
			const res = await get("/", env);
			expect(res.status).toBe(200);
			expect(joinHref()).toBeUndefined();
			await settle();
		}

		const api = await (await get("/api/guild", env)).json();
		expect(api).toMatchObject({ success: true, data: { inviteUrl: null } });
	});

	it.each([
		["no join link", null, undefined],
		["the widget's own invite", "https://discord.com/invite/Widget1", "https://discord.com/invite/Widget1"],
	])(
		"keeps withholding a foreign configured invite when a later refresh fails for another reason (e.g. 429) — %s",
		async (_label, instantInvite, expectedHref) => {
			vi.setSystemTime(new Date("2026-10-20T12:00:00.000Z"));
			const foreign = { ...invite, guild: { ...invite.guild, id: FOREIGN_GUILD } };
			let inviteRoute: Route = () => json(foreign);
			vi.stubGlobal("fetch", discordFetch({ invite: () => inviteRoute(), widget: () => json({ ...widget, instant_invite: instantInvite }) }));
			const env = envWith("OTHER");
			const inviteUrl = async () => ((await (await get("/api/guild", env)).json()) as { data: { inviteUrl: string | null } }).data.inviteUrl;

			expect(await inviteUrl()).toBe(instantInvite); // load 1: Discord rejects the code
			await settle();

			inviteRoute = () => json({ message: "You are being rate limited." }, 429);
			vi.setSystemTime(Date.now() + FRESH_MS + 60_000);
			await inviteUrl(); // due: serves the cached snapshot and refreshes in the background
			await settle();

			expect(await inviteUrl()).toBe(instantInvite); // the refreshed snapshot
			RecordingRewriter.ops = [];
			await get("/", env);
			expect(joinHref()?.[3]).toBe(expectedHref);
			expect(JSON.stringify(RecordingRewriter.ops)).not.toContain("discord.gg/OTHER");
		},
	);

	it("falls back to the configured link when Discord is unavailable, including during the backoff", async () => {
		vi.stubGlobal("fetch", discordFetch({}));
		const env = envWith("XmuHsQYX");

		for (let i = 0; i < 2; i++) {
			RecordingRewriter.ops = [];
			await get("/", env);
			expect(joinHref()).toEqual(["a#join", "setAttribute", "href", "https://discord.gg/XmuHsQYX"]);
			await settle();
		}
		expect(errors).toHaveBeenCalledTimes(1); // the failure itself; the backoff is not a new one
	});

	it("does not render the configured link while the first load is still pending", async () => {
		vi.stubGlobal("fetch", discordFetch({ invite: never, widget: never }));

		const page = get("/", envWith("XmuHsQYX"));
		await vi.advanceTimersByTimeAsync(2_000);
		const res = await page;

		expect(res.status).toBe(200);
		expect(joinHref()).toBeUndefined();
		expect(RecordingRewriter.ops).toContainEqual(["script#initial-data", "setInnerContent", "null", { html: true }]);
	});

	it("server-renders the snapshot's own invite and the split layout when data arrives in time", async () => {
		vi.stubGlobal("fetch", discordFetch({ invite: () => json(invite), widget: () => json(widget), application: () => json(application) }));

		const res = await get("/", envWith("XmuHsQYX"));
		expect(res.headers.get("Cache-Control")).toBe("no-cache");
		expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
		expect(joinHref()).toEqual(["a#join", "setAttribute", "href", "https://discord.gg/XmuHsQYX"]);
		expect(RecordingRewriter.ops).toContainEqual(["main.stage", "setAttribute", "data-layout", "split"]);
		await settle();
	});
});
