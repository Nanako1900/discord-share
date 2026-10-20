// Renders the guild snapshot (see GuildSnapshot in src/snapshot.ts).
// All user-controlled strings go through textContent — never innerHTML.

const COPY_FEEDBACK_MS = 2400;
// A failure is an instruction ("复制失败，请手动复制上方链接"): give people time to act on it.
const COPY_ERROR_MS = 8000;
const LOAD_ERROR = "暂时无法获取服务器信息";
// /api/guild answers 503 + Retry-After while the Worker loads its first snapshot.
const MAX_FETCH_ATTEMPTS = 4;
const DEFAULT_RETRY_MS = 2000;
const MIN_RETRY_MS = 250;
const MAX_RETRY_MS = 10_000;
// Name width buckets (CJK counts double). CSS moves "medium" names under the icon on
// narrow cards only, "long" names always (and clamps them to three lines).
const MEDIUM_NAME_UNITS = 20;
const LONG_NAME_UNITS = 32;
const WIDE_CHAR_RE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;
const DISCORD_INVITE_RE = /^https:\/\/(?:discord\.gg|discord\.com\/invite)\/[A-Za-z0-9-]+$/;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
// Greys (black/white/neutral) have no hue to borrow: keep the default teal instead.
const MIN_BRAND_SPREAD = 24;
// Counts from here on are shortened (123.5\u4e07) so the stats strip never overflows.
const COMPACT_FROM = 100_000;
// Voice rows shown before the remaining idle channels fold into one expandable row.
const MAX_VOICE_ROWS = 6;
// Side by side, cards whose natural heights differ by more than about one member row
// (after the tray has absorbed what it can) are top-aligned instead of stretched.
const FIT_SLACK_PX = 48;

const STATUS_LABELS = new Map([
	["online", "在线"],
	["idle", "离开"],
	["dnd", "请勿打扰"],
]);
const VERIFICATION_LABELS = ["无", "低", "中", "高", "最高"];
const FEATURE_LABELS = new Map([
	["VERIFIED", "官方认证"],
	["PARTNERED", "Discord 合作伙伴"],
	["COMMUNITY", "社区服务器"],
	["DISCOVERABLE", "可被发现"],
	["NEWS", "公告频道"],
	["WELCOME_SCREEN_ENABLED", "欢迎界面"],
	["MEMBER_VERIFICATION_GATE_ENABLED", "成员筛选"],
	["GUESTS_ENABLED", "访客模式"],
	["SOUNDBOARD", "音效板"],
	["ANIMATED_ICON", "动态图标"],
	["ANIMATED_BANNER", "动态横幅"],
	["BANNER", "服务器横幅"],
	["INVITE_SPLASH", "邀请背景"],
	["VANITY_URL", "自定义邀请链接"],
	["ROLE_ICONS", "身份组图标"],
	["ROLE_SUBSCRIPTIONS_ENABLED", "付费身份组"],
	["TICKETED_EVENTS_ENABLED", "售票活动"],
	["AUTO_MODERATION", "自动审核"],
	["TEXT_IN_VOICE_ENABLED", "语音频道文字聊天"],
	["VIDEO_QUALITY_720_60FPS", "720p 60fps 视频"],
	["VIDEO_QUALITY_1080_60FPS", "1080p 60fps 视频"],
	["VIDEO_BITRATE_ENHANCED", "增强视频码率"],
	["AUDIO_BITRATE_128_KBPS", "128kbps 音质"],
	["AUDIO_BITRATE_256_KBPS", "256kbps 音质"],
	["AUDIO_BITRATE_384_KBPS", "384kbps 音质"],
	["STAGE_CHANNEL_VIEWERS_50", "舞台 50 人"],
	["STAGE_CHANNEL_VIEWERS_150", "舞台 150 人"],
	["STAGE_CHANNEL_VIEWERS_300", "舞台 300 人"],
]);
const ACCENT_FEATURES = new Set(["VERIFIED", "PARTNERED", "COMMUNITY"]);

const numberFormat = new Intl.NumberFormat("zh-CN");
const compactFormat = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumSignificantDigits: 3 });
const dateFormat = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" });
const timeFormat = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });

const $ = (selector) => document.querySelector(selector);
const ui = {
	stage: $(".stage"),
	card: $(".card--identity"),
	cover: $(".cover__img"),
	coin: $(".coin__img"),
	initial: $(".coin__initial"),
	tag: $("#guild-tag"),
	name: $("#guild-name"),
	since: $("#guild-since"),
	description: $("#guild-description"),
	foot: $(".card__foot"),
	members: $('[data-count="members"]'),
	online: $('[data-count="online"]'),
	onlineLed: $(".gauge__label .led"),
	voice: $('[data-count="voice"]'),
	voiceGauge: $("#voice-gauge"),
	join: $("#join"),
	copy: $("#copy"),
	inviteText: $("#invite-text"),
	copyStatus: $("#copy-status"),
	inviteNone: $("#invite-none"),
	error: $(".card__error"),
	errorText: $(".card__error p"),
	retry: $("#retry"),
	facts: $("#facts"),
	games: $("#games"),
	gamesList: $("#games-list"),
	features: $("#features"),
	featuresList: $("#features-list"),
	updated: $("#updated"),
	staleNote: $("#stale-note"),
	live: $("#live"),
	liveLed: $(".live__title .led"),
	liveSub: $("#live-sub"),
	voiceList: $("#voice-list"),
	voiceEmpty: $("#voice-empty"),
	statusSummary: $("#status-summary"),
	playing: $("#playing"),
	memberSection: $(".live__section--members"),
	memberWell: $(".well--scroll"),
	memberGrid: $("#member-grid"),
	memberEmpty: $("#member-empty"),
	memberMore: $("#member-more"),
};

let copyTimer;
let hasRendered = false;

/** Tiny element builder: props.text → textContent, other props → attributes. */
function h(tag, props = {}, children = []) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (value === null || value === undefined) continue;
		if (key === "class") node.className = value;
		else if (key === "text") node.textContent = value;
		else node.setAttribute(key, String(value));
	}
	node.append(...children.filter(Boolean));
	return node;
}

const firstChar = (text) => Array.from(String(text ?? "").trim())[0] ?? "?";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Rough rendered width of a name: wide (CJK, emoji) characters count as two. */
const nameUnits = (text) =>
	Array.from(String(text ?? "")).reduce((n, ch) => n + (WIDE_CHAR_RE.test(ch) || ch.codePointAt(0) > 0xffff ? 2 : 1), 0);
/** The one online number shown everywhere: the guild's presence count, else the widget's. */
const onlineCount = (snapshot) => snapshot.guild?.onlineCount ?? snapshot.widget?.onlineCount ?? null;
const formatCount = (value) => {
	if (typeof value !== "number") return "—";
	return value >= COMPACT_FROM ? compactFormat.format(value) : numberFormat.format(value);
};
const statusLabel = (status) => STATUS_LABELS.get(status) ?? "离线";

function nameSize(name) {
	const units = nameUnits(name);
	if (units > LONG_NAME_UNITS) return "long";
	return units > MEDIUM_NAME_UNITS ? "medium" : "short";
}

/** A brand colour worth borrowing: valid #rrggbb with some hue (not black, white or grey). */
function isChromaticHex(color) {
	if (typeof color !== "string" || !HEX_COLOR_RE.test(color)) return false;
	const n = Number.parseInt(color.slice(1), 16);
	const channels = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
	return Math.max(...channels) - Math.min(...channels) >= MIN_BRAND_SPREAD;
}

function setCount(node, value) {
	if (typeof value === "number") node.textContent = formatCount(value);
	// Unknown: a visual dash, and a word for screen readers ("成员 未知", not "成员 破折号").
	else node.replaceChildren(h("span", { text: "—", "aria-hidden": "true" }), h("span", { class: "sr-only", text: "未知" }));
	if (typeof value === "number" && value >= COMPACT_FROM) node.title = numberFormat.format(value);
	else node.removeAttribute("title");
}

/** "online" only when someone is actually online; 0 or unknown keeps the light grey. */
const ledStatus = (online) => (typeof online === "number" && online > 0 ? "online" : "offline");

function setImage(img, url) {
	if (url) {
		img.src = url;
		img.hidden = false;
	} else {
		img.removeAttribute("src");
		img.hidden = true;
	}
}

// ── Pieces ──────────────────────────────────────────────

function avatarFallback(name) {
	return h("span", { class: "avatar__fallback", text: firstChar(name), "aria-hidden": "true" });
}

function avatarImage(member, small) {
	const img = h("img", {
		src: member.avatarUrl,
		alt: "",
		width: small ? 24 : 34,
		height: small ? 24 : 34,
		loading: "lazy",
		decoding: "async",
		referrerpolicy: "no-referrer",
	});
	img.addEventListener("error", () => img.replaceWith(avatarFallback(member.name)), { once: true });
	return img;
}

function avatar(member, small = false) {
	return h("span", { class: small ? "avatar avatar--sm" : "avatar" }, [
		member.avatarUrl ? avatarImage(member, small) : avatarFallback(member.name),
		h("span", { class: "led", "data-status": member.status, "aria-hidden": "true" }),
	]);
}

/** Status for screen readers, read after the name ("kaneki（在线）") so rows skim by name. */
const statusText = (member) => h("span", { class: "sr-only", text: `（${statusLabel(member.status)}）` });

function voiceStateIcons(voice) {
	if (!voice) return [];
	return [
		voice.muted ? h("span", { class: "icon icon--muted", role: "img", "aria-label": "已静音" }) : null,
		voice.deafened ? h("span", { class: "icon icon--deafened", role: "img", "aria-label": "已关闭声音" }) : null,
	];
}

const isIdleChannel = (channel) => channel.members.length === 0;

function voiceItem(channel) {
	const empty = isIdleChannel(channel);
	return h("li", { class: empty ? "voice voice--empty" : "voice" }, [
		h("div", { class: "voice__head" }, [
			h("span", { class: "icon icon--speaker", "aria-hidden": "true" }),
			h("span", { class: "voice__name", text: channel.name, title: channel.name }),
			h("span", { class: "voice__count", text: empty ? "空闲" : `${channel.members.length} 人` }),
		]),
		empty
			? null
			: h(
					"ul",
					{ class: "voice__members" },
					channel.members.map((m) =>
						h("li", { class: "voice__member" }, [
							avatar(m, true),
							h("span", { class: "voice__member-name", text: m.name, title: m.name }),
							statusText(m),
							...voiceStateIcons(m.voice),
						]),
					),
				),
	]);
}

/** Idle channels past the row budget fold into a native disclosure row (still listed, one tap away). */
function foldedVoiceItem(channels) {
	return h("li", { class: "voice voice--empty voice--fold" }, [
		h("details", { class: "voice-fold" }, [
			h("summary", { class: "voice-fold__summary" }, [
				h("span", { class: "icon icon--chevron", "aria-hidden": "true" }),
				h("span", { text: `另有 ${numberFormat.format(channels.length)} 个空闲频道` }),
			]),
			h("ul", { class: "voice-fold__list" }, channels.map(voiceItem)),
		]),
	]);
}

/** Every busy channel stays visible; idle ones fill the remaining rows in their original order. */
function voiceRows(channels) {
	if (channels.length <= MAX_VOICE_ROWS + 1) return channels.map(voiceItem);
	let idleBudget = Math.max(MAX_VOICE_ROWS - 1 - channels.filter((c) => !isIdleChannel(c)).length, 0);
	const shown = [];
	const folded = [];
	for (const channel of channels) {
		if (!isIdleChannel(channel)) shown.push(channel);
		else if (idleBudget > 0) {
			shown.push(channel);
			idleBudget -= 1;
		} else folded.push(channel);
	}
	if (folded.length < 2) return channels.map(voiceItem);
	return [...shown.map(voiceItem), foldedVoiceItem(folded)];
}

function memberItem(member) {
	const activity = member.activity ? `正在玩 ${member.activity}` : null;
	return h("li", { class: "member" }, [
		avatar(member),
		h("div", { class: "member__text" }, [
			h("span", { class: "member__name", text: member.name, title: member.name }),
			statusText(member),
			activity ? h("span", { class: "member__activity", text: activity, title: activity }) : null,
		]),
	]);
}

/** value: a string, or nodes (e.g. nowrap phrases) for values that must break in a set place. */
function fact(label, value) {
	if (!value) return null;
	const dd = typeof value === "string" ? h("dd", { text: value }) : h("dd", {}, value);
	return h("div", { class: "fact" }, [h("dt", { text: label }), dd]);
}

/** "等级 3 ·" / "1,234 次加成": the line may only break between the two, never inside or before "·". */
function boostValue(guild) {
	const tier = guild.boostTier > 0 ? `等级 ${guild.boostTier}` : "未解锁";
	return [
		h("span", { class: "nowrap", text: `${tier} ·` }),
		" ",
		h("span", { class: "nowrap", text: `${numberFormat.format(guild.boostCount)} 次加成` }),
	];
}

// ── Sections ────────────────────────────────────────────

function renderIdentity(snapshot) {
	const guild = snapshot.guild;
	document.title = `${snapshot.name} | Discord`;
	if (isChromaticHex(guild?.brandColor)) {
		document.documentElement.style.setProperty("--brand", guild.brandColor);
	} else {
		document.documentElement.style.removeProperty("--brand");
	}

	setImage(ui.cover, guild?.bannerUrl ?? null);
	setImage(ui.coin, guild?.iconUrl ?? null);
	ui.initial.textContent = guild?.iconUrl ? "" : firstChar(snapshot.name);
	ui.tag.textContent = guild?.tag ?? "";
	ui.tag.hidden = !guild?.tag;

	ui.name.textContent = snapshot.name;
	ui.card.dataset.name = nameSize(snapshot.name);
	ui.since.textContent = `创建于 ${dateFormat.format(new Date(snapshot.createdAt))}`;
	ui.description.textContent = guild?.description ?? "";
	ui.description.hidden = !guild?.description;
}

function renderGauges(snapshot) {
	const widget = snapshot.widget;
	const inVoice = widget ? widget.voiceChannels.reduce((sum, c) => sum + c.members.length, 0) : null;
	const online = onlineCount(snapshot);
	setCount(ui.members, snapshot.guild?.memberCount);
	setCount(ui.online, online);
	setCount(ui.voice, inVoice);
	ui.voiceGauge.hidden = !widget;
	// Same rule as the live card's title light, so the two never disagree.
	ui.onlineLed.dataset.status = ledStatus(online);
}

/** Called with ready data only: no valid invite means "you can't join right now", said in words. */
function renderInvite(url) {
	const safe = typeof url === "string" && DISCORD_INVITE_RE.test(url) ? url : null;
	if (safe) {
		ui.join.href = safe;
		ui.join.removeAttribute("aria-disabled");
		ui.join.removeAttribute("role");
		ui.join.removeAttribute("aria-describedby");
	} else {
		ui.join.removeAttribute("href"); // not focusable, not activatable
		// An <a> without href is "generic": role=link keeps it announced as an unavailable link.
		ui.join.setAttribute("role", "link");
		ui.join.setAttribute("aria-disabled", "true");
		ui.join.setAttribute("aria-describedby", ui.inviteNone.id);
	}
	// One dimmed control with a reason beats two dead ones.
	ui.copy.disabled = !safe;
	ui.copy.hidden = !safe;
	ui.inviteNone.hidden = Boolean(safe);
	ui.inviteText.textContent = safe ? safe.replace(/^https:\/\//, "") : "";
}

function renderFacts(snapshot) {
	const guild = snapshot.guild;
	ui.facts.replaceChildren(
		...[
			fact("验证等级", guild ? VERIFICATION_LABELS[guild.verificationLevel] : null),
			fact("服务器加成", guild ? boostValue(guild) : null),
			fact("邀请频道", guild?.inviteChannel ? `#${guild.inviteChannel}` : null),
			fact("语音频道", snapshot.widget ? `${snapshot.widget.voiceChannels.length} 个` : null),
		].filter(Boolean),
	);
	ui.facts.hidden = ui.facts.childElementCount === 0;
}

function gameIcon(url) {
	const img = h("img", { src: url, alt: "", width: 24, height: 24, loading: "lazy", decoding: "async" });
	img.addEventListener("error", () => img.remove(), { once: true });
	return img;
}

function renderShelves(guild) {
	const games = guild?.games ?? [];
	ui.gamesList.replaceChildren(
		...games.map((game) =>
			h("li", { class: "chip" }, [
				game.iconUrl ? gameIcon(game.iconUrl) : null,
				h("span", { text: game.name, title: game.name }),
			]),
		),
	);
	ui.games.hidden = games.length === 0;

	const features = (guild?.features ?? []).filter((f) => FEATURE_LABELS.has(f));
	features.sort((a, b) => Number(ACCENT_FEATURES.has(b)) - Number(ACCENT_FEATURES.has(a)));
	ui.featuresList.replaceChildren(
		...features.map((f) =>
			h("li", { class: ACCENT_FEATURES.has(f) ? "stamp stamp--accent" : "stamp", text: FEATURE_LABELS.get(f) }),
		),
	);
	ui.features.hidden = features.length === 0;
}

function renderLive(snapshot) {
	const widget = snapshot.widget;
	ui.live.hidden = !widget;
	ui.stage.dataset.layout = widget ? "split" : "single";
	if (!widget) return;

	const online = onlineCount(snapshot);
	const inVoice = widget.voiceChannels.reduce((sum, c) => sum + c.members.length, 0);
	// Nobody online: the title light goes out instead of glowing next to "0 人在线".
	ui.liveLed.dataset.status = ledStatus(online);
	ui.liveSub.textContent = `${formatCount(online)} 人在线 · ${numberFormat.format(inVoice)} 人在语音`;
	ui.voiceList.replaceChildren(...voiceRows(widget.voiceChannels));
	ui.voiceEmpty.hidden = widget.voiceChannels.length > 0;

	renderMembers(widget, online);
}

function renderMembers(widget, online) {
	const listed = widget.members.length;
	const counts = new Map();
	for (const m of widget.members) counts.set(m.status, (counts.get(m.status) ?? 0) + 1);
	ui.statusSummary.hidden = listed === 0;
	ui.statusSummary.replaceChildren(
		...[...STATUS_LABELS].map(([status, label]) =>
			h("li", {}, [
				h("span", { class: "led", "data-status": status, "aria-hidden": "true" }),
				h("span", { text: `${label} ${counts.get(status) ?? 0}` }),
			]),
		),
	);

	renderPlaying(widget.members);

	ui.memberGrid.replaceChildren(...widget.members.map(memberItem));

	// Footer strip, the twin of the identity card's: who is missing, else how many are listed.
	// Nobody at all: "暂无在线成员" alone says it (the header already reads "0 人在线").
	const hidden = (online ?? 0) - listed;
	ui.memberMore.textContent =
		hidden > 0
			? `另有 ${numberFormat.format(hidden)} 位在线成员未在小工具中显示`
			: `小工具显示 ${numberFormat.format(listed)} 位在线成员`;
	ui.memberMore.hidden = listed === 0 && hidden <= 0;
	ui.memberEmpty.hidden = listed > 0 || hidden > 0;
}

function renderPlaying(members) {
	const games = new Map();
	for (const m of members) if (m.activity) games.set(m.activity, (games.get(m.activity) ?? 0) + 1);
	const top = [...games].sort((a, b) => b[1] - a[1]).slice(0, 5);
	// Each game is one unbreakable group that carries its own trailing "·", so lines only
	// break between games: a name never splits and a wrapped line never starts with "·".
	ui.playing.replaceChildren(
		h("span", { text: "正在玩：" }),
		...top.flatMap(([name, count], i) => [
			i > 0 ? " " : null,
			h("span", { class: "playing__game" }, [
				h("strong", { text: name, title: name }),
				count > 1 ? h("span", { text: `\u00a0×${count}` }) : null,
				i < top.length - 1 ? h("span", { text: "\u00a0·" }) : null,
			]),
		]).filter(Boolean),
	);
	ui.playing.hidden = top.length === 0;
}

const isShown = (el) => el.getClientRects().length > 0;
const px = (value) => Number.parseFloat(value) || 0;

/**
 * Free space a stretched container shows between its last in-flow child and `end`
 * (the footer, or the container's own content edge when there is no footer).
 */
function trailingSlack(container, end) {
	let last = null;
	for (const el of container.children) {
		if (el === end || !isShown(el)) continue;
		const bottom = el.getBoundingClientRect().bottom + px(getComputedStyle(el).marginBottom);
		last = last === null ? bottom : Math.max(last, bottom);
	}
	if (last === null) return 0;
	const box = container.getBoundingClientRect();
	const style = getComputedStyle(container);
	const edge =
		end && isShown(end)
			? end.getBoundingClientRect().top - px(getComputedStyle(end).marginTop)
			: box.bottom - px(style.paddingBottom) - px(style.borderBottomWidth);
	return Math.max(0, edge - last);
}

/**
 * Side by side: stretch both cards to one height when the member tray can make up the
 * difference, else top-align them ("short-live" / "short-identity"). Both natural heights
 * are measured the same way in every mode (no stretch slack, tray at its 3½-row minimum),
 * so the choice never flips back and forth.
 */
function fitMode() {
	if (ui.stage.dataset.layout !== "split" || ui.live.hidden || ui.card.dataset.state !== "ready") return null;
	// Layout offsets, not client rects: the cards' entrance animation translates them.
	const sideBySide =
		ui.live.offsetLeft >= ui.card.offsetLeft + ui.card.offsetWidth && Math.abs(ui.live.offsetTop - ui.card.offsetTop) <= 1;
	if (!sideBySide) return null;
	const idBox = ui.card.getBoundingClientRect();
	const liveBox = ui.live.getBoundingClientRect();

	const well = ui.memberWell;
	let trayShrink = 0;
	let trayGrow = 0;
	if (isShown(well)) {
		const style = getComputedStyle(well);
		const chrome = well.offsetHeight - well.clientHeight + px(style.paddingTop) + px(style.paddingBottom);
		const trayMin = px(style.minHeight);
		trayShrink = Math.max(0, well.offsetHeight - trayMin);
		trayGrow = Math.max(0, ui.memberGrid.offsetHeight + chrome - trayMin);
	}
	const identity = idBox.height - trailingSlack(ui.card, ui.foot);
	const live = liveBox.height - trailingSlack(ui.memberSection, ui.memberMore) - trayShrink;
	if (identity - live > trayGrow + FIT_SLACK_PX) return "short-live";
	if (live - identity > FIT_SLACK_PX) return "short-identity";
	return "stretch";
}

/**
 * Keeps the tray in step with its list: CSS reads the list height from --tray-content
 * (CSSOM, so CSP style-src 'self' is fine), the split layout picks its fit, and the tray
 * is a Tab stop only while it actually scrolls.
 */
function syncTray() {
	const well = ui.memberWell;
	const content = `${ui.memberGrid.offsetHeight}px`;
	if (well.style.getPropertyValue("--tray-content") !== content) well.style.setProperty("--tray-content", content);

	const fit = fitMode();
	if (fit === null) delete ui.stage.dataset.fit;
	else if (ui.stage.dataset.fit !== fit) ui.stage.dataset.fit = fit;

	if (well.scrollHeight > well.clientHeight + 1) well.tabIndex = 0;
	else if (document.activeElement !== well) well.removeAttribute("tabindex");
}

function render(snapshot) {
	renderIdentity(snapshot);
	renderGauges(snapshot);
	renderInvite(snapshot.inviteUrl);
	renderFacts(snapshot);
	renderShelves(snapshot.guild);
	renderLive(snapshot);

	ui.updated.dateTime = snapshot.fetchedAt;
	ui.updated.textContent = `数据更新于 ${timeFormat.format(new Date(snapshot.fetchedAt))}`;
	ui.staleNote.hidden = !snapshot.stale;
	ui.error.hidden = true;
	ui.card.dataset.state = "ready";
	ui.card.removeAttribute("aria-busy");
	hasRendered = true;
	syncTray(); // measured once the identity card shows everything
}

function showLoading() {
	ui.card.dataset.state = "loading";
	ui.card.setAttribute("aria-busy", "true");
}

let alertTimer;
function showError() {
	ui.card.dataset.state = "error";
	ui.card.removeAttribute("aria-busy");
	// Nothing rendered yet: a server-patched split layout would leave an empty live card.
	if (!hasRendered) {
		ui.live.hidden = true;
		ui.stage.dataset.layout = "single";
		delete ui.stage.dataset.fit;
	}
	ui.error.hidden = false;
	// Re-insert the text so a repeated failure (after 重试) is announced again.
	ui.errorText.textContent = "";
	clearTimeout(alertTimer);
	alertTimer = setTimeout(() => {
		ui.errorText.textContent = LOAD_ERROR;
	}, 60);
}

// ── Data ────────────────────────────────────────────────

/** Retry-After (delta-seconds or HTTP-date) in ms, clamped; the default when absent or invalid. */
function retryDelay(res) {
	const header = res.headers.get("Retry-After")?.trim();
	if (!header) return DEFAULT_RETRY_MS;
	const ms = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
	if (!Number.isFinite(ms)) return DEFAULT_RETRY_MS;
	return Math.min(Math.max(ms, MIN_RETRY_MS), MAX_RETRY_MS);
}

/** GET /api/guild. 503 (first snapshot still loading) is retried; anything else non-OK fails at once. */
async function fetchSnapshot() {
	for (let attempt = 1; ; attempt++) {
		const res = await fetch("/api/guild", { headers: { Accept: "application/json" } });
		if (res.status === 503 && attempt < MAX_FETCH_ATTEMPTS) {
			res.body?.cancel().catch(() => {});
			await sleep(retryDelay(res));
			continue;
		}
		if (!res.ok) throw new Error(`${LOAD_ERROR} (HTTP ${res.status})`);
		const body = await res.json();
		if (!body?.success || !body.data) throw new Error(LOAD_ERROR);
		return body.data;
	}
}

async function refresh() {
	showLoading();
	try {
		render(await fetchSnapshot());
		return true;
	} catch {
		showError();
		return false;
	}
}

function readInitialData() {
	try {
		return JSON.parse($("#initial-data")?.textContent ?? "null");
	} catch {
		return null;
	}
}

function flashCopy(message, ok) {
	ui.copyStatus.textContent = message;
	ui.copyStatus.dataset.tone = ok ? "ok" : "error";
	ui.copy.dataset.copied = String(ok);
	// The tick is drawn by CSS ([data-copied="true"]::before), so the name stays plain words.
	ui.copy.textContent = ok ? "已复制" : "复制邀请链接";
	clearTimeout(copyTimer);
	copyTimer = setTimeout(
		() => {
			ui.copyStatus.textContent = "";
			delete ui.copyStatus.dataset.tone;
			ui.copy.textContent = "复制邀请链接";
			delete ui.copy.dataset.copied;
		},
		ok ? COPY_FEEDBACK_MS : COPY_ERROR_MS,
	);
}

ui.copy.addEventListener("click", async () => {
	const url = ui.join.getAttribute("href");
	if (!url || !DISCORD_INVITE_RE.test(url)) return;
	try {
		await navigator.clipboard.writeText(url);
		flashCopy("邀请链接已复制到剪贴板", true);
	} catch {
		flashCopy("复制失败，请手动复制上方链接", false);
	}
});

// Retry keeps its own button in place (aria-disabled, not disabled, so focus is not lost):
// on success focus moves to the server name, on failure it stays on 重试.
let retrying = false;
ui.retry.addEventListener("click", async () => {
	if (retrying) return;
	retrying = true;
	ui.retry.setAttribute("aria-disabled", "true");
	const ok = await refresh();
	ui.retry.removeAttribute("aria-disabled");
	retrying = false;
	if (ok) ui.name.focus();
	else ui.retry.focus();
});

// Broken images: a missing icon falls back to the initial, a missing cover to the gradient.
ui.coin.addEventListener("error", () => {
	if (!ui.coin.getAttribute("src")) return;
	setImage(ui.coin, null);
	ui.initial.textContent = firstChar(ui.name.textContent);
});
ui.cover.addEventListener("error", () => {
	if (ui.cover.getAttribute("src")) setImage(ui.cover, null);
});

// Re-measure when either card or the tray changes size (layout switch, fonts, rotation,
// the voice fold opening). Batched into the next frame, so a fit change never re-enters
// the observer within one frame.
if ("ResizeObserver" in window) {
	let frame = 0;
	const observer = new ResizeObserver(() => {
		if (!frame)
			frame = requestAnimationFrame(() => {
				frame = 0;
				syncTray();
			});
	});
	for (const el of [ui.card, ui.live, ui.memberWell, ui.memberGrid]) observer.observe(el);
}

const initial = readInitialData();
let rendered = false;
if (initial) {
	try {
		render(initial);
		rendered = true;
	} catch {
		// Unexpected shape (e.g. an old cache entry): fall through to a fresh fetch.
	}
}
if (!rendered) refresh();
