import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BACKOFF_MS,
	FRESH_MS,
	getSnapshot,
	isReportedLoadError,
	LEASE_MS,
	STALE_MS,
	UpstreamBackoffError,
	UpstreamFailedError,
} from "../src/cache";
import type { SnapshotStore } from "../src/cache-store";
import type { StoredSnapshot } from "../src/snapshot";
import {
	ago,
	deferredLoad,
	due,
	harness,
	leased,
	memoryStore,
	notDue,
	NOW,
	NOW_MS,
	served,
	snapshotAt,
} from "./support/cache-harness";

// Fake timers drive the checks that follow every cache write (see settle()).
beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("getSnapshot: cold start", () => {
	it("leases the entry, then loads and stores a snapshot on a cache miss", async () => {
		const mem = memoryStore();
		const fresh = snapshotAt(NOW, "Fresh");
		const { run, settle } = harness(mem.store, async () => fresh);

		await expect(run()).resolves.toEqual(served(fresh));
		await settle();
		expect(mem.writes).toEqual([
			{ snapshot: null, state: "loading", nextRefreshAt: NOW_MS + LEASE_MS },
			{ snapshot: fresh, state: "ok", nextRefreshAt: NOW_MS + FRESH_MS },
		]);
	});

	it("registers the cold-start refresh with waitUntil so a client disconnect cannot cancel it mid-lease", async () => {
		const mem = memoryStore();
		const { load, resolve } = deferredLoad();
		const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();

		const result = getSnapshot({ store: mem.store, load, now: NOW, waitUntil, onError: vi.fn() });
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
		expect(waitUntil).toHaveBeenCalledTimes(1);

		resolve(snapshotAt(NOW));
		await expect(result).resolves.toMatchObject({ name: "Guild" });
		await vi.advanceTimersByTimeAsync(5_000);
		await waitUntil.mock.calls[0][0];
		expect(mem.current()).toMatchObject({ state: "ok" });
	});

	it("reports a cold-start failure through onError from the waitUntil chain, even if the caller never handles it", async () => {
		const mem = memoryStore();
		const failure = new Error("down");
		const onError = vi.fn();
		const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
		const load = async (): Promise<StoredSnapshot> => {
			throw failure;
		};

		// Simulates a cancelled handler: only the registered promise is ever observed.
		const result = getSnapshot({ store: mem.store, load, now: NOW, waitUntil, onError });
		result.catch(() => undefined);
		await vi.waitFor(() => expect(waitUntil).toHaveBeenCalledTimes(1));
		// The registered promise itself never rejects; it reports and records the failure.
		await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith(failure);
		expect(mem.current()).toEqual({ snapshot: null, state: "failed", nextRefreshAt: NOW_MS + BACKOFF_MS });
		await expect(result).rejects.toBeInstanceOf(UpstreamFailedError);
	});

	it("rejects a cold-start failure as UpstreamFailedError (already reported, cause attached) and records a negative entry", async () => {
		const mem = memoryStore();
		const failure = new Error("down");
		const { run, onError } = harness(mem.store, async () => {
			throw failure;
		});

		const error = await run().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(UpstreamFailedError);
		expect(error).toMatchObject({ message: expect.stringContaining("down"), cause: failure });
		expect(isReportedLoadError(error)).toBe(true);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(mem.current()).toEqual({ snapshot: null, state: "failed", nextRefreshAt: NOW_MS + BACKOFF_MS });
	});

	it("fails fast with UpstreamBackoffError without calling Discord during a negative backoff", async () => {
		const load = vi.fn(async () => snapshotAt(NOW));
		const { run } = harness(memoryStore(notDue(null, "failed")).store, load);

		await expect(run()).rejects.toBeInstanceOf(UpstreamBackoffError);
		expect(load).not.toHaveBeenCalled();
	});

	it("leases the entry again when a negative backoff expires, then retries", async () => {
		const mem = memoryStore(due(null, "failed"));
		const fresh = snapshotAt(NOW);
		const { run } = harness(mem.store, async () => fresh);

		await expect(run()).resolves.toEqual(served(fresh));
		expect(mem.writes[0]).toEqual({ snapshot: null, state: "loading", nextRefreshAt: NOW_MS + LEASE_MS });
	});

	it("retries once an abandoned loading lease expires", async () => {
		const fresh = snapshotAt(NOW);
		const { run } = harness(memoryStore(due(null, "loading")).store, async () => fresh);
		await expect(run()).resolves.toEqual(served(fresh));
	});

	it("does not overwrite a snapshot stored by a concurrent request with a late failure", async () => {
		const mem = memoryStore();
		const good = snapshotAt(NOW, "Good");
		const { run } = harness(mem.store, async () => {
			// Another request (e.g. in another isolate) succeeded while this one was still waiting.
			await mem.store.put({ snapshot: good, state: "ok", nextRefreshAt: NOW_MS + FRESH_MS });
			throw new Error("late failure");
		});

		await expect(run()).rejects.toThrow("late failure");
		expect(mem.current()).toEqual({ snapshot: good, state: "ok", nextRefreshAt: NOW_MS + FRESH_MS });

		// The next request is served the good snapshot instead of a backoff error.
		await expect(harness(mem.store, async () => snapshotAt(NOW)).run()).resolves.toMatchObject({ name: "Good" });
	});

	it("loads without writing anything when the store cannot be read (its state is unknown, which is not a miss)", async () => {
		const mem = memoryStore(notDue(snapshotAt(ago(1000), "Good")));
		mem.store.get = vi.fn(async () => {
			throw new Error("cache broken");
		});
		const fresh = snapshotAt(NOW);
		const { run, onError, settle } = harness(mem.store, async () => fresh);

		await expect(run()).resolves.toEqual(served(fresh));
		await settle();
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "cache broken" }));
		expect(mem.writes).toEqual([]);
	});

	it("does not back off over an entry it could not re-read (it may hold newer data); its lease expires instead", async () => {
		const mem = memoryStore();
		const get = vi.fn<SnapshotStore["get"]>().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("cache broken"));
		mem.store.get = get;
		const { run, onError, settle } = harness(mem.store, async () => {
			throw new Error("down");
		});

		await expect(run()).rejects.toThrow("down");
		await settle();
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "cache broken" }));
		expect(mem.writes).toEqual([{ snapshot: null, state: "loading", nextRefreshAt: NOW_MS + LEASE_MS }]);
	});

	it("keeps working when the store cannot be written", async () => {
		const mem = memoryStore();
		mem.store.put = vi.fn(async () => {
			throw new Error("put failed");
		});
		const fresh = snapshotAt(NOW);
		const { run, onError, settle } = harness(mem.store, async () => fresh);

		await expect(run()).resolves.toEqual(served(fresh));
		await settle();
		// The lease and the snapshot write; nothing was stored, so there is nothing to re-check.
		expect(onError).toHaveBeenCalledTimes(2);
	});
});

describe("getSnapshot: warm cache", () => {
	it("serves a cached snapshot without loading until it is due", async () => {
		const cached = snapshotAt(ago(1000));
		const load = vi.fn(async () => snapshotAt(NOW));
		const { run } = harness(memoryStore(notDue(cached)).store, load);

		await expect(run()).resolves.toEqual(served(cached));
		expect(load).not.toHaveBeenCalled();
	});

	it("serves the cached snapshot while another request holds the refresh lease", async () => {
		const cached = snapshotAt(ago(1000));
		const load = vi.fn(async () => snapshotAt(NOW));
		const { run } = harness(memoryStore(leased(cached)).store, load);

		await expect(run()).resolves.toEqual(served(cached));
		expect(load).not.toHaveBeenCalled();
	});

	it("serves a due snapshot immediately, leases the refresh, then stores the fresh one", async () => {
		const cached = snapshotAt(ago(FRESH_MS + 1), "Old");
		const fresh = snapshotAt(NOW, "New");
		const mem = memoryStore(due(cached));
		const { run, settle } = harness(mem.store, async () => fresh);

		await expect(run()).resolves.toMatchObject({ name: "Old", stale: false });
		await settle();
		expect(mem.writes).toEqual([
			{ snapshot: cached, state: "loading", nextRefreshAt: NOW_MS + LEASE_MS },
			{ snapshot: fresh, state: "ok", nextRefreshAt: NOW_MS + FRESH_MS },
		]);
	});

	it("does not start a second refresh while one is leased", async () => {
		const { load, resolve } = deferredLoad();
		const mem = memoryStore(due(snapshotAt(ago(FRESH_MS + 1))));
		const { run, settle } = harness(mem.store, load);

		await run();
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
		await run();
		await run();
		resolve(snapshotAt(NOW));
		await settle();
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("marks very old snapshots as stale", async () => {
		const { run } = harness(memoryStore(notDue(snapshotAt(ago(STALE_MS + 1)))).store, async () => snapshotAt(NOW));
		await expect(run()).resolves.toMatchObject({ stale: true });
	});

	it("passes the previous snapshot to the loader so partial failures can be merged", async () => {
		const cached = snapshotAt(ago(FRESH_MS + 1), "Old");
		const load = vi.fn(async () => snapshotAt(NOW));
		const { run, settle } = harness(memoryStore(due(cached)).store, load);
		await run();
		await settle();
		expect(load).toHaveBeenCalledWith(cached);
	});

	it("keeps the cached snapshot and backs off when a background refresh fails", async () => {
		const failure = new Error("429");
		const cached = snapshotAt(ago(FRESH_MS + 1));
		const mem = memoryStore(due(cached));
		const { run, settle, onError } = harness(mem.store, async () => {
			throw failure;
		});

		await expect(run()).resolves.toMatchObject({ name: "Guild" });
		await settle();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith(failure);
		expect(mem.current()).toEqual({ snapshot: cached, state: "failed", nextRefreshAt: NOW_MS + BACKOFF_MS });
	});

	it("does not replace a newer snapshot with a backoff entry when a background refresh fails late", async () => {
		const cached = snapshotAt(ago(FRESH_MS + 1), "Old");
		const newer = snapshotAt(ago(10), "Newer");
		const mem = memoryStore(due(cached));
		const { run, settle } = harness(mem.store, async () => {
			await mem.store.put({ snapshot: newer, state: "ok", nextRefreshAt: NOW_MS + FRESH_MS });
			throw new Error("late failure");
		});

		await run();
		await settle();
		expect(mem.current()).toEqual({ snapshot: newer, state: "ok", nextRefreshAt: NOW_MS + FRESH_MS });
	});

	it("counts a partially refreshed snapshot (same oldest source, newer other source) as newer", async () => {
		const cached: StoredSnapshot = {
			...snapshotAt(ago(FRESH_MS + 1)),
			sources: { guild: ago(FRESH_MS + 1).toISOString(), widget: ago(FRESH_MS + 1).toISOString() },
		};
		const partial: StoredSnapshot = { ...cached, sources: { guild: cached.sources.guild, widget: ago(5).toISOString() } };
		const mem = memoryStore(due(cached));
		const { run, settle } = harness(mem.store, async () => {
			await mem.store.put({ snapshot: partial, state: "ok", nextRefreshAt: NOW_MS + FRESH_MS });
			throw new Error("late failure");
		});

		await run();
		await settle();
		expect(mem.current()?.snapshot).toEqual(partial);
	});
});

describe("getSnapshot: what is served", () => {
	const withVerdict = (name: string): StoredSnapshot => ({ ...snapshotAt(ago(1000), name), inviteUrl: null, rejectedInviteCode: "PrivateStaff" });

	it("never serves internal state such as a rejected invite code (possibly another server's private invite)", async () => {
		const { run } = harness(memoryStore(notDue(withVerdict("Cached"))).store, async () => snapshotAt(NOW));
		const served = await run();
		expect(served).not.toHaveProperty("rejectedInviteCode");
		expect(JSON.stringify(served)).not.toContain("PrivateStaff");
	});

	it("strips it from a freshly loaded snapshot too, while keeping it in the cache for the next refresh", async () => {
		const mem = memoryStore();
		const load = vi.fn(async () => withVerdict("Fresh"));
		const { run, settle } = harness(mem.store, load);

		await expect(run()).resolves.not.toHaveProperty("rejectedInviteCode");
		await settle();
		expect(mem.current()?.snapshot).toMatchObject({ rejectedInviteCode: "PrivateStaff" });
	});

	it("hands the loader the stored snapshot, verdict included", async () => {
		const cached = { ...withVerdict("Old"), fetchedAt: ago(FRESH_MS + 1).toISOString() };
		const load = vi.fn(async () => snapshotAt(NOW));
		const { run, settle } = harness(memoryStore(due(cached)).store, load);
		await run();
		await settle();
		expect(load).toHaveBeenCalledWith(cached);
	});
});
