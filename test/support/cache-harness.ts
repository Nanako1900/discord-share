import { vi } from "vitest";
import { getSnapshot, LEASE_MS } from "../../src/cache";
import type { CacheEntry, SnapshotStore } from "../../src/cache-store";
import { publicSnapshot, type GuildSnapshot, type StoredSnapshot } from "../../src/snapshot";

export const NOW = new Date("2026-10-20T12:00:00.000Z");
export const NOW_MS = NOW.getTime();

export function snapshotAt(fetchedAt: Date, name = "Guild"): StoredSnapshot {
	return {
		id: "1114391825336250432",
		name,
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

export const ago = (ms: number) => new Date(NOW_MS - ms);
export const due = (snapshot: StoredSnapshot | null, state: CacheEntry["state"] = snapshot ? "ok" : "failed"): CacheEntry => ({
	snapshot,
	state,
	nextRefreshAt: NOW_MS - 1,
});
export const notDue = (snapshot: StoredSnapshot | null, state: CacheEntry["state"] = snapshot ? "ok" : "failed"): CacheEntry => ({
	snapshot,
	state,
	nextRefreshAt: NOW_MS + 1,
});
export const leased = (snapshot: StoredSnapshot | null): CacheEntry => ({ snapshot, state: "loading", nextRefreshAt: NOW_MS + LEASE_MS });

let storeCount = 0;

/** An in-memory store; each gets its own key, so loads are only shared through the same store. */
export function memoryStore(initial: CacheEntry | null = null) {
	const writes: CacheEntry[] = [];
	let value = initial;
	const store: SnapshotStore = {
		key: `memory-${++storeCount}`,
		get: vi.fn(async () => value),
		put: vi.fn(async (entry: CacheEntry) => {
			value = entry;
			writes.push(entry);
		}),
	};
	return { store, writes, current: () => value };
}

export type Loader = (previous: StoredSnapshot | null) => Promise<StoredSnapshot>;

/** What getSnapshot serves for a stored snapshot (internal fields stripped, not stale). */
export const served = (snapshot: StoredSnapshot): GuildSnapshot => publicSnapshot(snapshot);

/** Long enough for every waitUntil chain, including the checks after a cache write. */
const SETTLE_MS = 5_000;

export function harness(store: SnapshotStore, load: Loader) {
	const pending: Promise<unknown>[] = [];
	const onError = vi.fn();
	const run = () => getSnapshot({ store, load, now: NOW, waitUntil: (p) => pending.push(p), onError });
	const settle = async () => {
		if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(SETTLE_MS);
		await Promise.all(pending);
	};
	return { run, onError, settle };
}

/** A loader whose result the test resolves or rejects explicitly. */
export function deferredLoad() {
	let resolve!: (s: StoredSnapshot) => void;
	let reject!: (e: unknown) => void;
	const load = vi.fn<Loader>(
		() =>
			new Promise<StoredSnapshot>((res, rej) => {
				resolve = res;
				reject = rej;
			}),
	);
	return { load, resolve: (s: StoredSnapshot) => resolve(s), reject: (e: unknown) => reject(e) };
}

