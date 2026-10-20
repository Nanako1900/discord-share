import { describe, expect, it } from "vitest";
import { apiError, apiFailure, apiSuccess, LOADING_ERROR, UPSTREAM_ERROR } from "../src/api";
import { UpstreamBackoffError, UpstreamLoadingError } from "../src/cache";
import type { GuildSnapshot } from "../src/snapshot";

const snapshot: GuildSnapshot = {
	id: "1114391825336250432",
	name: "Nanako‘s Community",
	createdAt: "2023-06-03T03:15:15.559Z",
	inviteUrl: "https://discord.gg/XmuHsQYX",
	guild: null,
	widget: null,
	sources: { guild: null, widget: null },
	fetchedAt: "2026-10-20T12:00:00.000Z",
	stale: false,
};

describe("apiSuccess", () => {
	it("returns 200 with the snapshot in the envelope and a short public cache", async () => {
		const res = apiSuccess(snapshot);
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=30");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
		await expect(res.json()).resolves.toEqual({ success: true, data: snapshot, error: null });
	});
});

describe("apiFailure", () => {
	it("answers 503 + Retry-After while another request is loading the first snapshot", async () => {
		const res = apiFailure(new UpstreamLoadingError("loading"));
		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBe("2");
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		await expect(res.json()).resolves.toEqual({ success: false, data: null, error: LOADING_ERROR });
		expect(LOADING_ERROR).toBe("正在加载 Discord 数据");
	});

	it.each([new UpstreamBackoffError("backoff"), new Error("boom"), "weird"])("answers 502 for %s", async (error) => {
		const res = apiFailure(error);
		expect(res.status).toBe(502);
		expect(res.headers.get("Retry-After")).toBeNull();
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		await expect(res.json()).resolves.toEqual({ success: false, data: null, error: UPSTREAM_ERROR });
	});

	it("never leaks internal error messages", async () => {
		const res = apiFailure(new Error("secret internal detail"));
		expect(await res.text()).not.toContain("secret");
	});
});

describe("apiError", () => {
	it("builds an uncached error envelope with the given status", async () => {
		const res = apiError("Not found", 404);
		expect(res.status).toBe(404);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		await expect(res.json()).resolves.toEqual({ success: false, data: null, error: "Not found" });
	});
});
