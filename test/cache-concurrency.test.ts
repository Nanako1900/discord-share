import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sleep } from "../src/async";
import {
	FRESH_MS,
	getSnapshot,
	LEASE_MS,
	UpstreamFailedError,
	UpstreamLoadingError,
	type GetSnapshotOptions,
} from "../src/cache";
import type { SnapshotStore } from "../src/cache-store";
import type { StoredSnapshot } from "../src/snapshot";
import { ago, due, notDue, NOW, NOW_MS, snapshotAt } from "./support/cache-harness";
import { failingFirstRead, sharedStore } from "./support/shared-store";

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

type Load = GetSnapshotOptions["load"];

/** Settles `ms` after the test started (fake time). */
const at = (ms: number) => sleep(Math.max(0, NOW_MS + ms - Date.now()));
const loadsAt = (ms: number, snapshot: StoredSnapshot) =>
	vi.fn<Load>(async () => {
		await at(ms);
		return snapshot;
	});
const failsAt = (ms: number) =>
	vi.fn<Load>(async () => {
		await at(ms);
		throw new Error("HTTP 429");
	});

function request(store: SnapshotStore, load: Load, now = NOW) {
	const onError = vi.fn();
	const result = getSnapshot({ store, load, now, waitUntil: () => undefined, onError });
	result.catch(() => undefined); // observed explicitly by each test
	return { result, onError };
}

/** Lets every load, write and post-write check run to completion. */
const finish = () => vi.advanceTimersByTimeAsync(10_000);

/** What a later request (cold isolate, Discord now failing) is served. */
async function nextRequestServes(store: SnapshotStore): Promise<unknown> {
	const next = request(store, failsAt(0));
	await finish();
	return next.result;
}

describe("getSnapshot: one load per isolate", () => {
	it("shares one load among concurrent requests, also those that read the store before the lease landed", async () => {
		const shared = sharedStore();
		const store = shared.view("isolate");
		const load = loadsAt(20, snapshotAt(NOW, "Fresh"));

		const results: Promise<unknown>[] = [];
		for (let i = 0; i < 8; i++) {
			results.push(request(store, load).result);
			await vi.advanceTimersByTimeAsync(1);
		}
		await finish();

		for (const result of results) await expect(result).resolves.toMatchObject({ name: "Fresh" });
		expect(load).toHaveBeenCalledTimes(1);
		expect(shared.log).toEqual(["loading:null", "ok:Fresh"]);
	});

	it("shares a due refresh the same way", async () => {
		const shared = sharedStore(due(snapshotAt(ago(FRESH_MS + 1), "Old")));
		const store = shared.view("isolate");
		const load = loadsAt(20, snapshotAt(NOW, "New"));

		const results: Promise<unknown>[] = [];
		for (let i = 0; i < 4; i++) {
			results.push(request(store, load).result);
			await vi.advanceTimersByTimeAsync(1);
		}
		await finish();

		for (const result of results) await expect(result).resolves.toMatchObject({ name: "Old" });
		expect(load).toHaveBeenCalledTimes(1);
		expect(shared.current()).toMatchObject({ state: "ok", snapshot: { name: "New" } });
	});

	it("stops waiting for a load that outlives its lease (answers 'still loading') and starts afresh after it", async () => {
		const store = sharedStore().view("isolate");
		const hung = vi.fn<Load>(() => new Promise<StoredSnapshot>(() => undefined));

		const first = request(store, hung);
		await vi.advanceTimersByTimeAsync(LEASE_MS - 100);
		expect(await Promise.race([first.result.then(() => "settled", () => "settled"), "waiting"])).toBe("waiting");
		await vi.advanceTimersByTimeAsync(200);
		await expect(first.result).rejects.toBeInstanceOf(UpstreamLoadingError);
		expect(hung).toHaveBeenCalledTimes(1);

		const later = new Date(NOW_MS + LEASE_MS + 1);
		const retry = request(store, loadsAt(LEASE_MS + 50, snapshotAt(later, "Fresh")), later);
		await finish();
		await expect(retry.result).resolves.toMatchObject({ name: "Fresh" });
	});
});

describe("getSnapshot: concurrent loads in different isolates (no compare-and-swap)", () => {
	it("keeps a fresh cold-start snapshot when another isolate's load fails just before it lands", async () => {
		const shared = sharedStore();
		const a = request(shared.view("isolate-a"), loadsAt(100, snapshotAt(NOW, "A")));
		const b = request(shared.view("isolate-b"), failsAt(97));
		await finish();

		await expect(a.result).resolves.toMatchObject({ name: "A" });
		await expect(b.result).rejects.toBeInstanceOf(UpstreamFailedError);
		// B re-read the store before A's write landed, so its backoff entry still lands on top; A restores its entry.
		expect(shared.log).toEqual(["loading:null", "loading:null", "ok:A", "failed:null", "ok:A"]);
		expect(shared.current()).toMatchObject({ state: "ok", snapshot: { name: "A" } });

		// The next request is served A, not a backoff error.
		await expect(nextRequestServes(shared.view("isolate-c"))).resolves.toMatchObject({ name: "A" });
	});

	it("keeps the newer snapshot when a refresh of the same due entry fails late in another isolate", async () => {
		const shared = sharedStore(due(snapshotAt(ago(FRESH_MS + 1), "S0")));
		const a = request(shared.view("isolate-a"), loadsAt(100, snapshotAt(NOW, "S1")));
		const b = request(shared.view("isolate-b"), failsAt(97));
		await finish();

		await expect(a.result).resolves.toMatchObject({ name: "S0" });
		await expect(b.result).resolves.toMatchObject({ name: "S0" });
		expect(shared.current()).toMatchObject({ state: "ok", snapshot: { name: "S1" } });
	});

	it("repairs the entry when another isolate's lease lands after the fresh snapshot", async () => {
		const shared = sharedStore();
		const a = request(shared.view("isolate-a"), loadsAt(50, snapshotAt(NOW, "A")));
		const slowLease = shared.view("isolate-b", { put: (_entry, n) => (n === 0 ? 150 : 5) });
		const b = request(slowLease, failsAt(60));
		await finish();

		await expect(a.result).resolves.toMatchObject({ name: "A" });
		await expect(b.result).rejects.toBeInstanceOf(UpstreamFailedError);
		expect(shared.current()).toMatchObject({ state: "ok", snapshot: { name: "A" } });
		await expect(nextRequestServes(shared.view("isolate-c"))).resolves.toMatchObject({ name: "A" });
	});
});

describe("getSnapshot: the store cannot be read", () => {
	it("writes nothing over an entry it could not read, so a failed load cannot evict the cached snapshot", async () => {
		const shared = sharedStore(notDue(snapshotAt(ago(1000), "Good")));
		const store = failingFirstRead(shared.view("isolate"));

		const first = request(store, failsAt(50));
		await finish();
		await expect(first.result).rejects.toBeInstanceOf(UpstreamFailedError);
		expect(first.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "transient cache read error" }));
		expect(shared.log).toEqual([]);

		await expect(nextRequestServes(store)).resolves.toMatchObject({ name: "Good" });
	});

	it("keeps serving the cached snapshot to other requests while the request that could not read it loads", async () => {
		const shared = sharedStore(notDue(snapshotAt(ago(1000), "Good")));
		const slow = request(failingFirstRead(shared.view("isolate-a")), loadsAt(8_000, snapshotAt(NOW, "Fresh")));
		await vi.advanceTimersByTimeAsync(10);

		const other = request(shared.view("isolate-b"), failsAt(0));
		await vi.advanceTimersByTimeAsync(10);
		await expect(other.result).resolves.toMatchObject({ name: "Good" });

		await finish();
		await expect(slow.result).resolves.toMatchObject({ name: "Fresh" });
		expect(shared.log).toEqual([]);
	});

	it("joins this isolate's load instead of starting another one", async () => {
		const shared = sharedStore();
		const view = shared.view("isolate");
		const load = loadsAt(100, snapshotAt(NOW, "Fresh"));

		const owner = request(view, load);
		await vi.advanceTimersByTimeAsync(10);
		const unreadable = request(failingFirstRead(view), load);
		await finish();

		await expect(owner.result).resolves.toMatchObject({ name: "Fresh" });
		await expect(unreadable.result).resolves.toMatchObject({ name: "Fresh" });
		expect(load).toHaveBeenCalledTimes(1);
	});
});
