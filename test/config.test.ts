import { describe, expect, it } from "vitest";
import { ConfigError, readConfig } from "../src/config";

const valid = {
	GUILD_ID: "1114391825336250432",
	INVITE_CODE: "XmuHsQYX",
	SITE_URL: "https://discord.nanako.org",
	SITE_NAME: "Nanako's Community",
};

describe("readConfig", () => {
	it("returns a normalized config for valid vars", () => {
		expect(readConfig(valid)).toEqual({
			guildId: "1114391825336250432",
			inviteCode: "XmuHsQYX",
			siteUrl: "https://discord.nanako.org",
			siteName: "Nanako's Community",
		});
	});

	it("treats an empty INVITE_CODE as 'use the widget invite'", () => {
		expect(readConfig({ ...valid, INVITE_CODE: "" }).inviteCode).toBeNull();
		expect(readConfig({ ...valid, INVITE_CODE: undefined }).inviteCode).toBeNull();
	});

	it("strips a trailing path from SITE_URL", () => {
		expect(readConfig({ ...valid, SITE_URL: "https://discord.nanako.org/" }).siteUrl).toBe(
			"https://discord.nanako.org",
		);
	});

	it("defaults SITE_NAME when it is missing", () => {
		expect(readConfig({ ...valid, SITE_NAME: undefined }).siteName).toBe("Discord 服务器");
	});

	it.each([
		["GUILD_ID", "abc"],
		["GUILD_ID", "123"],
		["GUILD_ID", undefined],
		// Unquoted snowflakes lose precision when parsed as JSON numbers
		["GUILD_ID", 1114391825336250432],
		["INVITE_CODE", "bad code!"],
		["INVITE_CODE", "x"],
		["INVITE_CODE", 12345],
		["SITE_URL", "not a url"],
		["SITE_URL", "http://discord.nanako.org"],
		["SITE_NAME", "x".repeat(101)],
	])("rejects invalid %s = %j", (key, value) => {
		expect(() => readConfig({ ...valid, [key]: value })).toThrow(ConfigError);
	});
});
