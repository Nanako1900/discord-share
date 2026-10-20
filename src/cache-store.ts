import type { StoredSnapshot } from "./snapshot";

/** How long the edge keeps the last entry around. */
const STORE_TTL_SECONDS = 86_400;

/**
 * ok      — the last refresh succeeded (snapshot is always present).
 * loading — a refresh holds the lease until `nextRefreshAt`.
 * failed  — the last refresh failed; back off until `nextRefreshAt`.
 */
export type CacheState = "ok" | "loading" | "failed";
const CACHE_STATES: readonly string[] = ["ok", "loading", "failed"] satisfies CacheState[];

export interface CacheEntry {
	/** null until a first load succeeds (cold start or negative cache). */
	snapshot: StoredSnapshot | null;
	state: CacheState;
	/** Epoch ms before which no request should call Discord. */
	nextRefreshAt: number;
}

export interface SnapshotStore {
	/** Identifies the entry; requests in one isolate share a single load per key. */
	readonly key: string;
	/**
	 * Resolves null on a miss or an unusable (malformed, outdated, corrupt) entry, which may
	 * be overwritten. Rejects when the store itself fails: the stored state is then unknown.
	 */
	get(): Promise<CacheEntry | null>;
	put(entry: CacheEntry): Promise<void>;
}

export function createCacheStore(cache: Cache, key: string): SnapshotStore {
	return {
		key,
		async get() {
			const res = await cache.match(key);
			if (!res) return null;
			const body = await parseBody(res);
			return isEntry(body) ? body : null;
		},
		async put(entry) {
			const res = new Response(JSON.stringify(entry), {
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": `public, max-age=${STORE_TTL_SECONDS}`,
				},
			});
			await cache.put(key, res);
		},
	};
}

/**
 * Invalid JSON means a corrupt entry: nothing worth protecting, so it reads as a miss
 * and gets overwritten. Any other error (reading the body failed) propagates: the
 * stored state is unknown and must not be overwritten on a guess.
 */
async function parseBody(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch (error) {
		if (error instanceof SyntaxError) return null;
		throw error;
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isNullableString = (value: unknown): boolean => value === null || typeof value === "string";

function isEntry(value: unknown): value is CacheEntry {
	if (!isRecord(value)) return false;
	const { snapshot, state, nextRefreshAt } = value;
	if (typeof nextRefreshAt !== "number" || typeof state !== "string" || !CACHE_STATES.includes(state)) return false;
	return snapshot === null ? state !== "ok" : isSnapshot(snapshot);
}

function isSnapshot(value: unknown): value is StoredSnapshot {
	if (!isRecord(value)) return false;
	const { sources } = value;
	return (
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.createdAt === "string" &&
		typeof value.fetchedAt === "string" &&
		isNullableString(value.rejectedInviteCode) &&
		"guild" in value &&
		"widget" in value &&
		isRecord(sources) &&
		isNullableString(sources.guild) &&
		isNullableString(sources.widget)
	);
}
