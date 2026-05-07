import { describe, expect, it } from "bun:test";

import {
	enabledProviderToolsToHostTools,
	normalizeActiveToolNames,
	removeHostSideTools,
} from "../src/active-tools";

describe("active tools helpers", () => {
	it("normalizes OMP string active tools to tool names", () => {
		expect(normalizeActiveToolNames(["read", "web_search", "generate_image"])).toEqual([
			"read",
			"web_search",
			"generate_image",
		]);
	});

	it("normalizes Pi object active tools by name", () => {
		expect(normalizeActiveToolNames([{ name: "read" }, { name: "web_search", description: "search" }])).toEqual([
			"read",
			"web_search",
		]);
	});

	it("ignores malformed active tool objects", () => {
		expect(
			normalizeActiveToolNames([
				"read",
				{ name: "web_search" },
				{ name: "" },
				{ title: "generate_image" },
				null,
				undefined,
				42,
			]),
		).toEqual(["read", "web_search"]);
	});

	it("maps enabled provider tools to corresponding host-side tools", () => {
		expect(enabledProviderToolsToHostTools(["web_search"])).toEqual(["web_search"]);
		expect(enabledProviderToolsToHostTools(["image_generation"])).toEqual(["generate_image"]);
		expect(enabledProviderToolsToHostTools(["web_search", "image_generation"])).toEqual([
			"web_search",
			"generate_image",
		]);
	});

	it("maps no enabled provider tools to no host-side removals", () => {
		expect(enabledProviderToolsToHostTools([])).toEqual([]);
		expect(removeHostSideTools(["read", "web_search"], [])).toEqual({
			removed: false,
			toolNames: ["read", "web_search"],
		});
	});

	it("removes only requested host-side tools", () => {
		expect(removeHostSideTools(["read", "web_search", "generate_image"], ["web_search"])).toEqual({
			removed: true,
			toolNames: ["read", "generate_image"],
		});
	});

	it("reports no removal when target host-side tools are absent", () => {
		expect(removeHostSideTools(["read", "edit"], ["web_search", "generate_image"])).toEqual({
			removed: false,
			toolNames: ["read", "edit"],
		});
	});
});
