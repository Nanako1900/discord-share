import { UpstreamLoadingError } from "./cache";
import type { GuildSnapshot } from "./snapshot";

/** Response envelope of every /api/* endpoint. */
export interface ApiEnvelope<T> {
	success: boolean;
	data: T | null;
	error: string | null;
}

export const UPSTREAM_ERROR = "暂时无法获取 Discord 服务器信息，请稍后再试";
export const LOADING_ERROR = "正在加载 Discord 数据";
/** Seconds a client should wait before retrying while the first snapshot loads. */
const LOADING_RETRY_AFTER_SECONDS = 2;
const API_CACHE_CONTROL = "public, max-age=30";

function json<T>(body: ApiEnvelope<T>, status: number, headers: Readonly<Record<string, string>> = {}): Response {
	return Response.json(body, {
		status,
		headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
	});
}

/** 200 with the snapshot; briefly cacheable by browsers and the edge. */
export function apiSuccess(snapshot: GuildSnapshot): Response {
	return json({ success: true, data: snapshot, error: null }, 200, { "Cache-Control": API_CACHE_CONTROL });
}

/**
 * 503 + Retry-After while another request loads the first snapshot (the client
 * retries), 502 for every other upstream failure. Never exposes error details.
 */
export function apiFailure(error: unknown): Response {
	if (error instanceof UpstreamLoadingError) {
		return json({ success: false, data: null, error: LOADING_ERROR }, 503, {
			"Retry-After": String(LOADING_RETRY_AFTER_SECONDS),
		});
	}
	return json({ success: false, data: null, error: UPSTREAM_ERROR }, 502);
}

/** Uncached error envelope for non-upstream errors (404, misconfiguration). */
export function apiError(message: string, status: number): Response {
	return json({ success: false, data: null, error: message }, status);
}
