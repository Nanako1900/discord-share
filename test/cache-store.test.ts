import { describe, expect, it, vi } from "vitest";
import { createCacheStore, type CacheEntry } from "../src/cache-store";
import type { StoredSnapshot } from "../src/snapshot";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const NOW_MS = NOW.getTime();

function snapshotAt(fetchedAt: Date): StoredSnapshot {
	return {
		id: "1114391825336250432",
		name: "Guild",
		createdAt: "2023-06-03T03:15:15.559Z",
		inviteUrl: "https://discord.gg/x",
		rejectedInviteCode: null,
		guild: null,
		widget: null,
		sources: { guild: null, widget: null },
		fetchedAt: fetchedAt.toISOString(),
		stale: false,
	};
}

describe("createCacheStore", () => {
	function fakeCache() {
		const entries = new Map<string, Response>();
		const cache = {
			match: vi.fn(async (key: string) => entries.get(key)?.clone()),
			put: vi.fn(async (key: string, res: Response) => {
				entries.set(key, res);
			}),
		};
		return { cache: cache as unknown as Cache, entries };
	}

	it("round-trips an entry with a long-lived Cache-Control header", async () => {
		const { cache, entries } = fakeCache();
		const store = createCacheStore(cache, "https://discord.nanako.org/__cache/k");
		const entry: CacheEntry = { snapshot: snapshotAt(NOW), state: "ok", nextRefreshAt: NOW_MS };

		await store.put(entry);
		await expect(store.get()).resolves.toEqual(entry);
		expect(entries.get("https://discord.nanako.org/__cache/k")?.headers.get("Cache-Control")).toBe(
			"public, max-age=86400",
		);
	});

	it.each<CacheEntry["state"]>(["loading", "failed"])("round-trips an empty %s entry", async (state) => {
		const { cache } = fakeCache();
		const store = createCacheStore(cache, "https://x/k");
		await store.put({ snapshot: null, state, nextRefreshAt: NOW_MS });
		await expect(store.get()).resolves.toEqual({ snapshot: null, state, nextRefreshAt: NOW_MS });
	});

	it("round-trips a snapshot with source timestamps", async () => {
		const { cache } = fakeCache();
		const store = createCacheStore(cache, "https://x/k");
		const snapshot = { ...snapshotAt(NOW), sources: { guild: NOW.toISOString(), widget: null } };
		await store.put({ snapshot, state: "loading", nextRefreshAt: NOW_MS });
		await expect(store.get()).resolves.toMatchObject({ snapshot: { sources: { guild: NOW.toISOString(), widget: null } } });
	});

	it("round-trips a snapshot that carries a rejected invite code", async () => {
		const { cache } = fakeCache();
		const store = createCacheStore(cache, "https://x/k");
		const snapshot = { ...snapshotAt(NOW), inviteUrl: null, rejectedInviteCode: "OTHER" };
		await store.put({ snapshot, state: "ok", nextRefreshAt: NOW_MS });
		await expect(store.get()).resolves.toMatchObject({ snapshot: { inviteUrl: null, rejectedInviteCode: "OTHER" } });
	});

	it("exposes its key (in-isolate loads are shared per key)", () => {
		const { cache } = fakeCache();
		expect(createCacheStore(cache, "https://x/k").key).toBe("https://x/k");
	});

	it("treats an unparseable body as a corrupt entry, i.e. a miss that may be overwritten", async () => {
		const { cache, entries } = fakeCache();
		entries.set("https://x/k", new Response("{not json"));
		await expect(createCacheStore(cache, "https://x/k").get()).resolves.toBeNull();
	});

	it("rejects when the cache itself fails, leaving the stored state unknown (not a miss)", async () => {
		const { cache } = fakeCache();
		vi.mocked(cache.match).mockRejectedValueOnce(new Error("cache unavailable"));
		await expect(createCacheStore(cache, "https://x/k").get()).rejects.toThrow("cache unavailable");
	});

	it("rejects when reading the body fails for a reason other than its content", async () => {
		const { cache } = fakeCache();
		const broken = new Response(
			new ReadableStream({
				pull(controller) {
					controller.error(new TypeError("stream read failed"));
				},
			}),
		);
		vi.mocked(cache.match).mockResolvedValueOnce(broken);
		await expect(createCacheStore(cache, "https://x/k").get()).rejects.toThrow("stream read failed");
	});

	it("returns null on a miss", async () => {
		const { cache } = fakeCache();
		await expect(createCacheStore(cache, "https://x/k").get()).resolves.toBeNull();
	});

	const valid = snapshotAt(NOW);
	it.each([
		null,
		{ nope: true },
		{ snapshot: { name: 1 }, state: "ok", nextRefreshAt: 1 },
		{ snapshot: null, state: "failed", nextRefreshAt: "soon" },
		// v2-era entry shape (no `state`)
		{ snapshot: valid, nextRefreshAt: 1 },
		{ snapshot: null, nextRefreshAt: 1 },
		{ snapshot: valid, state: "bogus", nextRefreshAt: 1 },
		// an "ok" entry must carry a snapshot
		{ snapshot: null, state: "ok", nextRefreshAt: 1 },
		// v2-era snapshot shape (no `sources`)
		{ snapshot: { ...valid, sources: undefined }, state: "ok", nextRefreshAt: 1 },
		{ snapshot: { ...valid, sources: { guild: 1, widget: null } }, state: "ok", nextRefreshAt: 1 },
		{ snapshot: { ...valid, sources: { guild: null } }, state: "ok", nextRefreshAt: 1 },
		// v3-era snapshot shape (no `rejectedInviteCode`): it could re-advertise a withheld code
		{ snapshot: { ...valid, rejectedInviteCode: undefined }, state: "ok", nextRefreshAt: 1 },
		{ snapshot: { ...valid, rejectedInviteCode: 1 }, state: "ok", nextRefreshAt: 1 },
		// v1-era snapshot shape (no `id`/`createdAt`)
		{ snapshot: { name: "x", fetchedAt: "2026-01-01T00:00:00Z", inviteUrl: "https://discord.gg/x" }, state: "ok", nextRefreshAt: 1 },
	])("returns null for malformed cached payloads: %j", async (payload) => {
		const { cache, entries } = fakeCache();
		entries.set("https://x/k", new Response(JSON.stringify(payload)));
		await expect(createCacheStore(cache, "https://x/k").get()).resolves.toBeNull();
	});
});
