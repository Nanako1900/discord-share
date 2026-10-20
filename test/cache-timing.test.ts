import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BACKOFF_MS,
	FRESH_MS,
	isReportedLoadError,
	LEASE_MS,
	LOADING_POLL_MS,
	LOADING_WAIT_MS,
	STALE_MS,
	SYNC_REFRESH_BUDGET_MS,
	UpstreamBackoffError,
	UpstreamFailedError,
	UpstreamLoadingError,
} from "../src/cache";
import type { SnapshotStore } from "../src/cache-store";
import { REQUEST_TIMEOUT_MS } from "../src/discord";
import { ago, deferredLoad, due, harness, leased, memoryStore, NOW, NOW_MS, served, snapshotAt } from "./support/cache-harness";

afterEach(() => {
	vi.useRealTimers();
});

describe("getSnapshot: another request is loading the first snapshot", () => {
	it("waits for the in-flight load instead of calling Discord again", async () => {
		vi.useFakeTimers();
		const mem = memoryStore();
		const { load, resolve } = deferredLoad();
		const { run } = harness(mem.store, load);

		const first = run();
		await vi.advanceTimersByTimeAsync(0);
		expect(load).toHaveBeenCalledTimes(1);
		const waiting = [run(), run()];
		await vi.advanceTimersByTimeAsync(LOADING_POLL_MS);

		resolve(snapshotAt(NOW, "Fresh"));
		await vi.advanceTimersByTimeAsync(LOADING_POLL_MS);
		await expect(first).resolves.toMatchObject({ name: "Fresh" });
		for (const result of waiting) await expect(result).resolves.toMatchObject({ name: "Fresh", stale: false });
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("gives up with UpstreamLoadingError (→ 503 + Retry-After) once the wait budget is spent", async () => {
		vi.useFakeTimers();
		const mem = memoryStore(leased(null));
		const load = vi.fn(async () => snapshotAt(NOW));
		const { run } = harness(mem.store, load);

		let settled = false;
		const result = run().finally(() => {
			settled = true;
		});
		const rejection = expect(result).rejects.toBeInstanceOf(UpstreamLoadingError);
		await vi.advanceTimersByTimeAsync(LOADING_WAIT_MS - 1);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await rejection;
		expect(load).not.toHaveBeenCalled();
		expect(mem.store.get).toHaveBeenCalledTimes(1 + LOADING_WAIT_MS / LOADING_POLL_MS);
	});

	it("answers UpstreamBackoffError when the in-flight load fails while waiting", async () => {
		vi.useFakeTimers();
		const mem = memoryStore(leased(null));
		const { run } = harness(mem.store, async () => snapshotAt(NOW));

		const rejection = expect(run()).rejects.toBeInstanceOf(UpstreamBackoffError);
		await mem.store.put({ snapshot: null, state: "failed", nextRefreshAt: NOW_MS + BACKOFF_MS });
		await vi.advanceTimersByTimeAsync(LOADING_POLL_MS);
		await rejection;
	});

	it("keeps waiting through a failing store read, reporting it", async () => {
		vi.useFakeTimers();
		const mem = memoryStore(leased(null));
		const get = vi
			.fn<SnapshotStore["get"]>()
			.mockResolvedValueOnce(leased(null))
			.mockRejectedValueOnce(new Error("cache broken"))
			.mockResolvedValue({ snapshot: snapshotAt(NOW, "Fresh"), state: "ok", nextRefreshAt: NOW_MS + FRESH_MS });
		mem.store.get = get;
		const { run, onError } = harness(mem.store, async () => snapshotAt(NOW));

		const result = run();
		await vi.advanceTimersByTimeAsync(2 * LOADING_POLL_MS);
		await expect(result).resolves.toMatchObject({ name: "Fresh" });
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "cache broken" }));
	});
});

describe("getSnapshot: stale and due", () => {
	const old = () => snapshotAt(ago(STALE_MS + 1), "Old");

	it("waits briefly for the refresh and serves the fresh snapshot when it arrives in time", async () => {
		vi.useFakeTimers();
		const fresh = snapshotAt(NOW, "New");
		const { run, settle } = harness(memoryStore(due(old())).store, async () => fresh);
		await expect(run()).resolves.toEqual(served(fresh));
		await settle();
	});

	it("serves the old snapshot marked stale when the refresh exceeds the budget, and keeps refreshing", async () => {
		vi.useFakeTimers();
		const { load, resolve } = deferredLoad();
		const mem = memoryStore(due(old()));
		const { run, settle } = harness(mem.store, load);

		const result = run();
		await vi.advanceTimersByTimeAsync(SYNC_REFRESH_BUDGET_MS);
		await expect(result).resolves.toMatchObject({ name: "Old", stale: true });

		const fresh = snapshotAt(NOW, "New");
		resolve(fresh);
		await settle();
		expect(mem.current()).toEqual({ snapshot: fresh, state: "ok", nextRefreshAt: NOW_MS + FRESH_MS });
	});

	it("never blocks for longer than the budget", async () => {
		vi.useFakeTimers();
		const { load } = deferredLoad();
		const { run } = harness(memoryStore(due(old())).store, load);

		let settled = false;
		const result = run().then((s) => {
			settled = true;
			return s;
		});
		await vi.advanceTimersByTimeAsync(SYNC_REFRESH_BUDGET_MS - 1);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(result).resolves.toMatchObject({ name: "Old" });
	});

	it("falls back to the old snapshot, marked stale, when that refresh fails (logged once)", async () => {
		const failure = new Error("down");
		const { run, onError, settle } = harness(memoryStore(due(old())).store, async () => {
			throw failure;
		});
		await expect(run()).resolves.toMatchObject({ name: "Old", stale: true });
		await settle();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith(failure);
	});

	it("keeps the budget below the time the page waits for data", () => {
		expect(SYNC_REFRESH_BUDGET_MS).toBe(1_500);
	});
});

describe("cache timing constants", () => {
	it("leases a refresh for longer than its worst case (widget → invite → games, each with a timeout)", () => {
		expect(LEASE_MS).toBeGreaterThan(3 * REQUEST_TIMEOUT_MS);
		expect(LEASE_MS).toBe(30_000);
	});

	it("never holds a request waiting on another load for a full upstream timeout", () => {
		expect(LOADING_WAIT_MS).toBeLessThan(REQUEST_TIMEOUT_MS);
		expect(LOADING_WAIT_MS % LOADING_POLL_MS).toBe(0);
	});
});

describe("isReportedLoadError", () => {
	it("recognizes cache-state rejections and failures getSnapshot already reported, but nothing else", () => {
		expect(isReportedLoadError(new UpstreamBackoffError("x"))).toBe(true);
		expect(isReportedLoadError(new UpstreamLoadingError("x"))).toBe(true);
		expect(isReportedLoadError(new UpstreamFailedError("x", { cause: new Error("y") }))).toBe(true);
		expect(isReportedLoadError(new Error("x"))).toBe(false);
		expect(isReportedLoadError("x")).toBe(false);
	});
});
