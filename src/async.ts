/** How a promise ended within a time budget. */
export type Settled<T> = { kind: "value"; value: T } | { kind: "error"; error: unknown } | { kind: "timeout" };

/**
 * Races the promise against a timer. Never rejects: a failure is reported as
 * `error`, distinct from running out of time, and the timer is always cleared.
 */
export async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
	// The executor runs synchronously, so the timer is always set before `finally`.
	let timer!: ReturnType<typeof setTimeout>;
	const timeout = new Promise<Settled<T>>((resolve) => {
		timer = setTimeout(resolve, ms, { kind: "timeout" });
	});
	const settled = promise.then(
		(value): Settled<T> => ({ kind: "value", value }),
		(error: unknown): Settled<T> => ({ kind: "error", error }),
	);
	try {
		return await Promise.race([settled, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Resolves with the promise's value if it fulfills within `ms`, otherwise null.
 * Never rejects (callers observe failures through their own handler).
 */
export async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	const result = await raceTimeout(promise, ms);
	return result.kind === "value" ? result.value : null;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
