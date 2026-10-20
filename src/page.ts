import type { Settled } from "./async";
import { UpstreamLoadingError } from "./cache";
import { safeJsonForScript, type PageMeta } from "./html";
import type { GuildSnapshot } from "./snapshot";

/** One HTMLRewriter edit, kept as data so the rewrite plan is unit-testable outside workerd. */
export type PagePatch =
	| { selector: string; kind: "attr"; name: string; value: string }
	| { selector: string; kind: "removeAttr"; name: string }
	| { selector: string; kind: "text"; value: string }
	| { selector: string; kind: "html"; value: string }
	| { selector: string; kind: "remove" };

/** The subset of HTMLRewriter's Element that patches need. */
export interface PatchTarget {
	setAttribute(name: string, value: string): unknown;
	removeAttribute(name: string): unknown;
	setInnerContent(content: string, options?: { html?: boolean }): unknown;
	remove(): unknown;
}

const META_ATTRIBUTES: ReadonlyArray<[selector: string, attribute: string, field: keyof PageMeta]> = [
	['meta[name="description"]', "content", "description"],
	['meta[property="og:title"]', "content", "title"],
	['meta[property="og:description"]', "content", "description"],
	['meta[property="og:url"]', "content", "url"],
	['meta[property="og:image"]', "content", "image"],
	['meta[name="twitter:title"]', "content", "title"],
	['meta[name="twitter:description"]', "content", "description"],
	['meta[name="twitter:image"]', "content", "image"],
	['link[rel="canonical"]', "href", "url"],
];

/**
 * What the Worker knows about the Discord data when it renders the page:
 * - snapshot:    data arrived in time;
 * - pending:     a load is still running (this request's or another's) — the client fetches its result;
 * - unavailable: the load failed or is backing off, so Discord is known to be unreachable.
 */
export type PageData = { kind: "snapshot"; snapshot: GuildSnapshot } | { kind: "pending" } | { kind: "unavailable" };

export function pageDataFrom(result: Settled<GuildSnapshot>): PageData {
	switch (result.kind) {
		case "value":
			return { kind: "snapshot", snapshot: result.value };
		case "timeout":
			return { kind: "pending" };
		case "error":
			return result.error instanceof UpstreamLoadingError ? { kind: "pending" } : { kind: "unavailable" };
	}
}

export function snapshotOf(data: PageData): GuildSnapshot | null {
	return data.kind === "snapshot" ? data.snapshot : null;
}

/**
 * The join url to server-render. A snapshot's (validated) inviteUrl is authoritative —
 * even when null, e.g. because the configured code belongs to another guild (a verdict
 * that is cached as a snapshot). The configured code is a fallback only when Discord is
 * known to be unreachable: while a load is pending it may yet reject that code, so
 * nothing is rendered and the client fills the link in from /api/guild.
 */
export function joinUrlFor(data: PageData, configuredInviteCode: string | null): string | null {
	if (data.kind === "snapshot") return data.snapshot.inviteUrl;
	if (data.kind === "pending" || !configuredInviteCode) return null;
	return `https://discord.gg/${configuredInviteCode}`;
}

/** Everything the Worker injects into public/index.html before it reaches the browser. */
export function pagePatches(
	meta: PageMeta,
	snapshot: GuildSnapshot | null,
	name: string,
	inviteUrl: string | null,
): PagePatch[] {
	return [
		{ selector: "title", kind: "text", value: meta.title },
		...META_ATTRIBUTES.map(([selector, attribute, field]): PagePatch => {
			const value = meta[field];
			return value === null ? { selector, kind: "remove" } : { selector, kind: "attr", name: attribute, value };
		}),
		{ selector: "h1#guild-name", kind: "text", value: name },
		{ selector: "script#initial-data", kind: "html", value: safeJsonForScript(snapshot) },
		...joinPatches(inviteUrl),
		...layoutPatches(snapshot),
	];
}

/** Server-render the join controls so they work even when Discord data is unavailable. */
function joinPatches(inviteUrl: string | null): PagePatch[] {
	if (!inviteUrl) return [];
	return [
		{ selector: "a#join", kind: "attr", name: "href", value: inviteUrl },
		{ selector: "a#join", kind: "removeAttr", name: "aria-disabled" },
		{ selector: "button#copy", kind: "removeAttr", name: "disabled" },
		{ selector: "#invite-text", kind: "text", value: inviteUrl.replace(/^https:\/\//, "") },
	];
}

/** Match the client's layout on first paint so the live card doesn't pop in after the script runs. */
function layoutPatches(snapshot: GuildSnapshot | null): PagePatch[] {
	if (!snapshot?.widget) return [];
	return [
		{ selector: "main.stage", kind: "attr", name: "data-layout", value: "split" },
		{ selector: "article#live", kind: "removeAttr", name: "hidden" },
	];
}

export function applyPatch(el: PatchTarget, patch: PagePatch): void {
	switch (patch.kind) {
		case "attr":
			el.setAttribute(patch.name, patch.value);
			return;
		case "removeAttr":
			el.removeAttribute(patch.name);
			return;
		case "text":
			el.setInnerContent(patch.value);
			return;
		case "html":
			el.setInnerContent(patch.value, { html: true });
			return;
		case "remove":
			el.remove();
			return;
	}
}
