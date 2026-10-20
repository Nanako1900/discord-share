import { raceTimeout, settleWithin, sleep } from "./async";
import type { CacheEntry, SnapshotStore } from "./cache-store";
import { publicSnapshot, type GuildSnapshot, type StoredSnapshot } from "./snapshot";

/** After a successful refresh, serve the snapshot as-is for this long. */
export const FRESH_MS = 120_000;
/** Older than this, a snapshot is flagged stale and a due refresh is briefly awaited. */
export const STALE_MS = 600_000;
/** After a failed refresh, don't call Discord again for this long. */
export const BACKOFF_MS = 60_000;
/**
 * A refresh claims the entry for this long so other requests don't duplicate it.
 * Must exceed the worst case: widget (5s) → invite (5s, sequential without
 * INVITE_CODE) → game lookups (5s) ≈ 15s. An in-isolate load older than this is
 * presumed dead: nobody joins it or waits for it any longer.
 */
export const LEASE_MS = 30_000;
/** How long a request with a stale snapshot waits for the refresh before serving the old copy. */
export const SYNC_REFRESH_BUDGET_MS = 1_500;
/**
 * How long a request with nothing cached waits for another isolate's first load
 * (polling the store) before answering "still loading". Shorter than one upstream
 * timeout, so a request is never held for a slow Discord it didn't even call.
 */
export const LOADING_WAIT_MS = 4_000;
export const LOADING_POLL_MS = 250;
/**
 * The Cache API has no compare-and-swap: another isolate's late lease or failure entry
 * can land on top of a fresh one. After storing it, the winner re-reads the entry after
 * each of these pauses (ms) and restores it if older data replaced it.
 */
export const REPAIR_DELAYS_MS: readonly number[] = [0, 250, 1_000];

/** A recent refresh failed and there is nothing cached to serve. */
export class UpstreamBackoffError extends Error {
	override name = "UpstreamBackoffError";
}

/** Another request is still loading the first snapshot; retry shortly. */
export class UpstreamLoadingError extends Error {
	override name = "UpstreamLoadingError";
}

/** The load this request waited for failed; `cause` was already reported through onError. */
export class UpstreamFailedError extends Error {
	override name = "UpstreamFailedError";
}

/**
 * Rejections from getSnapshot that need no further logging: cache-state errors
 * (loading, backoff) and failures getSnapshot already reported through onError.
 */
export function isReportedLoadError(error: unknown): boolean {
	return (
		error instanceof UpstreamBackoffError || error instanceof UpstreamLoadingError || error instanceof UpstreamFailedError
	);
}

export interface GetSnapshotOptions {
	store: SnapshotStore;
	/** Receives the cached snapshot so partial upstream failures can keep its data. */
	load: (previous: StoredSnapshot | null) => Promise<StoredSnapshot>;
	now: Date;
	waitUntil: (promise: Promise<unknown>) => void;
	/** The single place refresh and cache failures are reported (each exactly once). */
	onError: (error: unknown) => void;
}

/** A load in progress in this isolate, shared by every request for the same store key. */
interface Flight {
	/** Settles as soon as the load does, before anything is written. */
	result: Promise<StoredSnapshot>;
	expiresAt: number;
}

/** A started load: its result, and the bookkeeping (writes, reporting) that never rejects. */
interface Launch {
	result: Promise<StoredSnapshot>;
	done: Promise<void>;
}

/**
 * In-isolate singleflight. The lease only stops other isolates once its write lands, so
 * requests in this isolate that read the store before that would otherwise all load too.
 */
const flights = new Map<string, Flight>();

/** store.get() failed: what is stored is unknown, which is not the same as a miss. */
const UNREADABLE = Symbol("unreadable");
type ReadResult = CacheEntry | null | typeof UNREADABLE;

/**
 * Stale-while-revalidate with a refresh lease, an in-isolate singleflight and failure
 * backoff, so a traffic spike or a Discord outage never turns into a flood of upstream
 * requests. Serves public fields only. Throws only when there is nothing cached:
 * UpstreamFailedError when the load it waited for failed, UpstreamLoadingError while a
 * load is still running elsewhere, or UpstreamBackoffError after a recent failure.
 */
export async function getSnapshot(options: GetSnapshotOptions): Promise<GuildSnapshot> {
	const { store, now, onError } = options;
	const nowMs = now.getTime();
	const entry = await readEntry(store, onError);
	if (entry === UNREADABLE) {
		// The stored entry may be perfectly good for other requests: load without writing anything.
		return present(await awaitLoad(flightFor(options, nowMs, () => loadOnly(options)), nowMs), nowMs);
	}
	const cached = entry?.snapshot ?? null;

	if (entry && nowMs < entry.nextRefreshAt) {
		if (cached) return present(cached, nowMs);
		if (entry.state === "loading") return present(await awaitOtherLoad(store, onError), nowMs);
		throw new UpstreamBackoffError("Discord data unavailable; backing off");
	}

	const flight = flightFor(options, nowMs, () => refresh(options, cached, nowMs));
	if (!cached) return present(await awaitLoad(flight, nowMs), nowMs);
	if (!isStale(cached, nowMs)) return present(cached, nowMs);

	// Too old to serve silently: give the refresh a short head start, never the full upstream timeout.
	const fresh = await settleWithin(flight.result, SYNC_REFRESH_BUDGET_MS);
	return present(fresh ?? cached, nowMs);
}

/** Joins this isolate's load for the store's key, or launches one. */
function flightFor({ store, waitUntil, onError }: GetSnapshotOptions, nowMs: number, launch: () => Launch): Flight {
	const current = flights.get(store.key);
	if (current && nowMs < current.expiresAt) return current;

	const { result, done } = launch();
	const flight: Flight = { result, expiresAt: nowMs + LEASE_MS };
	flights.set(store.key, flight);
	// Registered by the request that launched it: the load must outlive a client that
	// disconnects (or it would hold the lease with nothing loading); failures are reported in `done`.
	waitUntil(
		done.catch(onError).finally(() => {
			if (flights.get(store.key) === flight) flights.delete(store.key);
		}),
	);
	return flight;
}

/** Waits for a load this request depends on (nothing cached), but never past its lease. */
async function awaitLoad(flight: Flight, nowMs: number): Promise<StoredSnapshot> {
	const settled = await raceTimeout(flight.result, flight.expiresAt - nowMs);
	switch (settled.kind) {
		case "value":
			return settled.value;
		case "timeout":
			throw new UpstreamLoadingError("Discord data is still being loaded");
		case "error":
			throw new UpstreamFailedError(`Discord load failed: ${describe(settled.error)}`, { cause: settled.error });
	}
}

async function readEntry(store: SnapshotStore, onError: (error: unknown) => void): Promise<ReadResult> {
	try {
		return await store.get();
	} catch (error) {
		onError(error);
		return UNREADABLE;
	}
}

/**
 * Another isolate holds the cold-start lease: briefly wait for its result instead
 * of failing at once (a typical first load takes well under the budget).
 */
async function awaitOtherLoad(store: SnapshotStore, onError: (error: unknown) => void): Promise<StoredSnapshot> {
	for (let waited = 0; waited < LOADING_WAIT_MS; waited += LOADING_POLL_MS) {
		await sleep(LOADING_POLL_MS);
		const entry = await readEntry(store, onError);
		if (entry === UNREADABLE) continue;
		if (entry?.snapshot) return entry.snapshot;
		if (entry?.state === "failed") throw new UpstreamBackoffError("Discord data unavailable; the first load failed");
	}
	throw new UpstreamLoadingError("Discord data is still being loaded by another request");
}

function refresh({ store, load, onError }: GetSnapshotOptions, cached: StoredSnapshot | null, nowMs: number): Launch {
	// Claim the refresh without waiting for the write: the load runs concurrently,
	// and only this refresh's own final write is ordered after its lease.
	const lease = tryPut(store, { snapshot: cached, state: "loading", nextRefreshAt: nowMs + LEASE_MS }, onError);
	const result = Promise.resolve(cached).then(load);
	const done = result.then(
		(fresh) => storeFresh(store, { snapshot: fresh, state: "ok", nextRefreshAt: nowMs + FRESH_MS }, lease, onError),
		async (error: unknown) => {
			onError(error);
			await lease;
			await recordFailure(store, cached, nowMs, onError);
		},
	);
	return { result, done };
}

/** A load for a request that could not read the store: nothing is written either way. */
function loadOnly({ load, onError }: GetSnapshotOptions): Launch {
	const result = Promise.resolve(null).then(load);
	return { result, done: result.then(() => undefined, onError) };
}

async function storeFresh(
	store: SnapshotStore,
	entry: CacheEntry & { snapshot: StoredSnapshot },
	lease: Promise<boolean>,
	onError: (error: unknown) => void,
): Promise<void> {
	await lease;
	if (!(await tryPut(store, entry, onError))) return; // the store rejects writes: nothing to protect
	for (const delay of REPAIR_DELAYS_MS) {
		if (delay > 0) await sleep(delay);
		const current = await readEntry(store, onError);
		if (current !== UNREADABLE && isNewer(entry.snapshot, current?.snapshot ?? null)) {
			await tryPut(store, entry, onError);
		}
	}
}

/**
 * Backs off — unless what is stored now is unknown, or newer than what this refresh
 * started from: either could be a concurrent request's good data, which must not be
 * clobbered. The lease then simply expires.
 */
async function recordFailure(
	store: SnapshotStore,
	startedFrom: StoredSnapshot | null,
	nowMs: number,
	onError: (error: unknown) => void,
): Promise<void> {
	const current = await readEntry(store, onError);
	if (current === UNREADABLE || isNewer(current?.snapshot ?? null, startedFrom)) return;
	await tryPut(store, { snapshot: startedFrom, state: "failed", nextRefreshAt: nowMs + BACKOFF_MS }, onError);
}

/** Resolves whether the write succeeded; a failure is reported, never thrown. */
function tryPut(store: SnapshotStore, entry: CacheEntry, onError: (error: unknown) => void): Promise<boolean> {
	return store.put(entry).then(
		() => true,
		(error: unknown) => {
			onError(error);
			return false;
		},
	);
}

function isNewer(candidate: GuildSnapshot | null, base: GuildSnapshot | null): boolean {
	if (!candidate) return false;
	if (!base) return true;
	return latestUpdate(candidate) > latestUpdate(base);
}

/**
 * fetchedAt is the *oldest* source, so a partial refresh can leave it unchanged;
 * the newest source time also moves forward on every successful refresh.
 */
function latestUpdate(snapshot: GuildSnapshot): number {
	const times = [snapshot.fetchedAt, snapshot.sources.guild, snapshot.sources.widget];
	return Math.max(...times.map((t) => (t ? Date.parse(t) : 0)));
}

const isStale = (snapshot: GuildSnapshot, nowMs: number): boolean => nowMs - Date.parse(snapshot.fetchedAt) > STALE_MS;

/** The one place snapshots leave the cache: public fields only, with the stale flag set. */
function present(snapshot: StoredSnapshot, nowMs: number): GuildSnapshot {
	return { ...publicSnapshot(snapshot), stale: isStale(snapshot, nowMs) };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
