import { describe, expect, it, vi } from "vitest";
import { UpstreamBackoffError, UpstreamFailedError, UpstreamLoadingError } from "../src/cache";
import type { PageMeta } from "../src/html";
import {
	applyPatch,
	joinUrlFor,
	pageDataFrom,
	pagePatches,
	snapshotOf,
	type PageData,
	type PagePatch,
	type PatchTarget,
} from "../src/page";
import type { GuildSnapshot, WidgetInfo } from "../src/snapshot";

const meta: PageMeta = {
	title: "Nanako‘s Community | Discord",
	description: "131 位成员 · 20 人在线",
	image: "https://cdn.discordapp.com/icons/1/a.png?size=512",
	url: "https://discord.nanako.org/",
};

const widget: WidgetInfo = { onlineCount: 3, members: [], voiceChannels: [] };

const snapshot: GuildSnapshot = {
	id: "1114391825336250432",
	name: "Nanako‘s Community",
	createdAt: "2023-06-03T03:15:15.559Z",
	inviteUrl: "https://discord.gg/XmuHsQYX",
	guild: null,
	widget: null,
	sources: { guild: "2026-10-20T12:00:00.000Z", widget: null },
	fetchedAt: "2026-10-20T12:00:00.000Z",
	stale: false,
};

const forSelector = (patches: PagePatch[], selector: string) => patches.filter((p) => p.selector === selector);

describe("pagePatches: metadata", () => {
	const patches = pagePatches(meta, snapshot, snapshot.name, snapshot.inviteUrl);

	it("sets the document title and share metadata", () => {
		expect(forSelector(patches, "title")).toEqual([{ selector: "title", kind: "text", value: meta.title }]);
		expect(patches).toEqual(
			expect.arrayContaining([
				{ selector: 'meta[name="description"]', kind: "attr", name: "content", value: meta.description },
				{ selector: 'meta[property="og:title"]', kind: "attr", name: "content", value: meta.title },
				{ selector: 'meta[property="og:description"]', kind: "attr", name: "content", value: meta.description },
				{ selector: 'meta[property="og:url"]', kind: "attr", name: "content", value: meta.url },
				{ selector: 'meta[property="og:image"]', kind: "attr", name: "content", value: meta.image },
				{ selector: 'meta[name="twitter:title"]', kind: "attr", name: "content", value: meta.title },
				{ selector: 'meta[name="twitter:description"]', kind: "attr", name: "content", value: meta.description },
				{ selector: 'meta[name="twitter:image"]', kind: "attr", name: "content", value: meta.image },
				{ selector: 'link[rel="canonical"]', kind: "attr", name: "href", value: meta.url },
			]),
		);
	});

	it("removes image tags instead of leaving them empty when there is no image", () => {
		const noImage = pagePatches({ ...meta, image: null }, snapshot, snapshot.name, null);
		expect(forSelector(noImage, 'meta[property="og:image"]')).toEqual([{ selector: 'meta[property="og:image"]', kind: "remove" }]);
		expect(forSelector(noImage, 'meta[name="twitter:image"]')).toEqual([{ selector: 'meta[name="twitter:image"]', kind: "remove" }]);
	});
});

describe("pagePatches: content", () => {
	it("renders the name as text, never as markup", () => {
		const hostile = "</h1><script>alert(1)</script>";
		const patches = pagePatches(meta, snapshot, hostile, null);
		expect(forSelector(patches, "h1#guild-name")).toEqual([{ selector: "h1#guild-name", kind: "text", value: hostile }]);
	});

	it("embeds the snapshot as script-safe JSON", () => {
		const hostile: GuildSnapshot = { ...snapshot, name: "</script><img src=x onerror=alert(1)>" };
		const [patch] = forSelector(pagePatches(meta, hostile, hostile.name, null), "script#initial-data");

		expect(patch).toMatchObject({ kind: "html" });
		const value = patch.kind === "html" ? patch.value : "";
		expect(value).not.toMatch(/[<>&]/);
		expect(JSON.parse(value)).toEqual(hostile);
	});

	it("embeds null when there is no snapshot", () => {
		expect(forSelector(pagePatches(meta, null, "Site", null), "script#initial-data")).toEqual([
			{ selector: "script#initial-data", kind: "html", value: "null" },
		]);
	});
});

describe("pagePatches: join controls", () => {
	it("enables the join link, copy button and invite text", () => {
		const patches = pagePatches(meta, snapshot, snapshot.name, "https://discord.gg/XmuHsQYX");
		expect(forSelector(patches, "a#join")).toEqual([
			{ selector: "a#join", kind: "attr", name: "href", value: "https://discord.gg/XmuHsQYX" },
			{ selector: "a#join", kind: "removeAttr", name: "aria-disabled" },
		]);
		expect(forSelector(patches, "button#copy")).toEqual([{ selector: "button#copy", kind: "removeAttr", name: "disabled" }]);
		expect(forSelector(patches, "#invite-text")).toEqual([{ selector: "#invite-text", kind: "text", value: "discord.gg/XmuHsQYX" }]);
	});

	it("leaves the join controls disabled without an invite url", () => {
		const patches = pagePatches(meta, snapshot, snapshot.name, null);
		for (const selector of ["a#join", "button#copy", "#invite-text"]) expect(forSelector(patches, selector)).toEqual([]);
	});
});

describe("pagePatches: first-paint layout", () => {
	it("shows the live card in a split layout when the snapshot has widget data", () => {
		const patches = pagePatches(meta, { ...snapshot, widget }, snapshot.name, null);
		expect(forSelector(patches, "main.stage")).toEqual([{ selector: "main.stage", kind: "attr", name: "data-layout", value: "split" }]);
		expect(forSelector(patches, "article#live")).toEqual([{ selector: "article#live", kind: "removeAttr", name: "hidden" }]);
	});

	it("keeps the single layout without widget data", () => {
		for (const s of [snapshot, null]) {
			const patches = pagePatches(meta, s, "Site", null);
			expect(forSelector(patches, "main.stage")).toEqual([]);
			expect(forSelector(patches, "article#live")).toEqual([]);
		}
	});
});

describe("pageDataFrom", () => {
	it("uses a snapshot that arrived in time", () => {
		expect(pageDataFrom({ kind: "value", value: snapshot })).toEqual({ kind: "snapshot", snapshot });
	});

	it("treats a timeout and another request's in-flight load as pending (the client fetches the result)", () => {
		expect(pageDataFrom({ kind: "timeout" })).toEqual({ kind: "pending" });
		expect(pageDataFrom({ kind: "error", error: new UpstreamLoadingError("x") })).toEqual({ kind: "pending" });
	});

	it.each([new UpstreamBackoffError("x"), new UpstreamFailedError("x", { cause: new Error("y") }), new Error("bug")])(
		"treats a settled failure (%s) as Discord being unavailable",
		(error) => {
			expect(pageDataFrom({ kind: "error", error })).toEqual({ kind: "unavailable" });
		},
	);
});

describe("snapshotOf", () => {
	it("returns the snapshot only when there is one", () => {
		expect(snapshotOf({ kind: "snapshot", snapshot })).toBe(snapshot);
		expect(snapshotOf({ kind: "pending" })).toBeNull();
		expect(snapshotOf({ kind: "unavailable" })).toBeNull();
	});
});

describe("joinUrlFor", () => {
	const withSnapshot = (s: GuildSnapshot): PageData => ({ kind: "snapshot", snapshot: s });

	it("uses the snapshot's invite url whenever there is a snapshot", () => {
		expect(joinUrlFor(withSnapshot(snapshot), "XmuHsQYX")).toBe("https://discord.gg/XmuHsQYX");
		expect(joinUrlFor(withSnapshot({ ...snapshot, inviteUrl: "https://discord.com/invite/abc" }), null)).toBe(
			"https://discord.com/invite/abc",
		);
	});

	it("does not re-introduce the configured code when the snapshot withheld it (e.g. invite for another guild)", () => {
		expect(joinUrlFor(withSnapshot({ ...snapshot, inviteUrl: null }), "XmuHsQYX")).toBeNull();
	});

	it("falls back to the configured code only when Discord is known to be unavailable", () => {
		expect(joinUrlFor({ kind: "unavailable" }, "XmuHsQYX")).toBe("https://discord.gg/XmuHsQYX");
		expect(joinUrlFor({ kind: "unavailable" }, null)).toBeNull();
	});

	it("does not render the configured code while a load that may yet reject it is pending", () => {
		expect(joinUrlFor({ kind: "pending" }, "XmuHsQYX")).toBeNull();
	});
});

describe("applyPatch", () => {
	function fakeElement() {
		return {
			setAttribute: vi.fn(),
			removeAttribute: vi.fn(),
			setInnerContent: vi.fn(),
			remove: vi.fn(),
		} satisfies PatchTarget;
	}

	it.each<[PagePatch, keyof PatchTarget, unknown[]]>([
		[{ selector: "a", kind: "attr", name: "href", value: "https://x" }, "setAttribute", ["href", "https://x"]],
		[{ selector: "a", kind: "removeAttr", name: "hidden" }, "removeAttribute", ["hidden"]],
		[{ selector: "a", kind: "text", value: "<b>" }, "setInnerContent", ["<b>"]],
		[{ selector: "a", kind: "html", value: "null" }, "setInnerContent", ["null", { html: true }]],
		[{ selector: "a", kind: "remove" }, "remove", []],
	])("applies %j", (patch, method, args) => {
		const el = fakeElement();
		applyPatch(el, patch);
		expect(el[method]).toHaveBeenCalledWith(...args);
		const others = (Object.keys(el) as Array<keyof PatchTarget>).filter((m) => m !== method);
		for (const other of others) expect(el[other]).not.toHaveBeenCalled();
	});

	it("never sets text content as html", () => {
		const el = fakeElement();
		applyPatch(el, { selector: "h1", kind: "text", value: "<script>" });
		expect(el.setInnerContent).toHaveBeenCalledWith("<script>");
		expect(el.setInnerContent.mock.calls[0]).toHaveLength(1);
	});
});
