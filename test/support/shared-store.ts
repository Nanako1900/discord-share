import { vi } from "vitest";
import { sleep } from "../../src/async";
import type { CacheEntry, SnapshotStore } from "../../src/cache-store";

/** Latency in ms of one store operation; `n` counts the puts made through that view. */
export interface Latency {
	get?: number;
	put?: (entry: CacheEntry, n: number) => number;
}

const DEFAULT_LATENCY_MS = 5;

const label = (entry: CacheEntry): string => `${entry.state}:${entry.snapshot?.name ?? "null"}`;

let storeCount = 0;

/**
 * One Cache API entry seen from several isolates. Every operation takes effect when it
 * completes (after its latency), like a remote store without compare-and-swap. Views of
 * different isolates never share an in-isolate load.
 */
export function sharedStore(initial: CacheEntry | null = null) {
	// Keys are unique per store, so in-isolate loads never leak from one test into another.
	const id = ++storeCount;
	let value = initial;
	const log: string[] = [];
	const view = (isolate: string, latency: Latency = {}): SnapshotStore => {
		let puts = 0;
		return {
			key: `shared-${id}/${isolate}`,
			async get() {
				await sleep(latency.get ?? DEFAULT_LATENCY_MS);
				return value;
			},
			async put(entry) {
				await sleep(latency.put?.(entry, puts++) ?? DEFAULT_LATENCY_MS);
				value = entry;
				log.push(label(entry));
			},
		};
	};
	return { view, log, current: () => value };
}

/** A view whose first read fails (a transient Cache API error), then reads normally. */
export function failingFirstRead(store: SnapshotStore): SnapshotStore {
	const get = vi
		.fn<SnapshotStore["get"]>()
		.mockRejectedValueOnce(new Error("transient cache read error"))
		.mockImplementation(() => store.get());
	return { key: store.key, get, put: (entry) => store.put(entry) };
}
