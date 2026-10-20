import { afterEach, describe, expect, it, vi } from "vitest";
import { raceTimeout, settleWithin, sleep } from "../src/async";

afterEach(() => {
	vi.useRealTimers();
});

describe("raceTimeout", () => {
	it("reports the value when the promise fulfills in time", async () => {
		await expect(raceTimeout(Promise.resolve("ok"), 1_000)).resolves.toEqual({ kind: "value", value: "ok" });
	});

	it("reports the error instead of rejecting", async () => {
		const error = new Error("boom");
		await expect(raceTimeout(Promise.reject(error), 1_000)).resolves.toEqual({ kind: "error", error });
	});

	it("reports a timeout, distinct from a failure, and clears its timer when the promise wins", async () => {
		vi.useFakeTimers();
		const late = raceTimeout(new Promise<string>(() => undefined), 500);
		await vi.advanceTimersByTimeAsync(500);
		await expect(late).resolves.toEqual({ kind: "timeout" });

		await raceTimeout(Promise.resolve("ok"), 500);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("settleWithin", () => {
	it("resolves with the value when the promise fulfills in time", async () => {
		await expect(settleWithin(Promise.resolve("ok"), 1_000)).resolves.toBe("ok");
	});

	it("resolves null instead of rejecting", async () => {
		await expect(settleWithin(Promise.reject(new Error("boom")), 1_000)).resolves.toBeNull();
	});

	it("resolves null after the timeout and clears its timer when the promise wins", async () => {
		vi.useFakeTimers();
		const never = new Promise<string>(() => undefined);
		const late = settleWithin(never, 500);
		await vi.advanceTimersByTimeAsync(500);
		await expect(late).resolves.toBeNull();

		await settleWithin(Promise.resolve("ok"), 500);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("sleep", () => {
	it("resolves after the given time", async () => {
		vi.useFakeTimers();
		let done = false;
		const slept = sleep(250).then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(249);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await slept;
		expect(done).toBe(true);
	});
});
