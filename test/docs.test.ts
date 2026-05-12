import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

describe("runtime documentation", () => {
	it("documents idle-gated UI-only web_search final card semantics", async () => {
		const readme = await fs.readFile(path.join(import.meta.dir, "../README.md"), "utf8");
		const compatibility = await fs.readFile(path.join(import.meta.dir, "../docs/runtime-compatibility.md"), "utf8");
		const combined = `${readme}\n${compatibility}`;

		const requiredSnippets = [
			"idle-gated display custom message",
			"context hook filtering",
			"UI-only custom entry replay",
			"after the runtime reports idle",
			"filtered from LLM context",
			"persisted and replayed through UI-only custom entries",
			"does not use non-overlay `ctx.ui.custom(..., { overlay: false })`",
			"editor replacement semantics",
			"does not use `{ deliverAs: \"nextTurn\" }` as the interactive primary path",
			"degrades without breaking the editor",
		];

		for (const snippet of requiredSnippets) {
			expect(combined).toContain(snippet);
		}

		const forbiddenSnippets = [
			"非 overlay final `web_search` custom card 保留在 editor 区域",
			"non-overlay final `web_search` custom card remains editor-resident",
			"Use this as the preferred UI-only final result card",
			"Prefer non-overlay `ctx.ui.custom(..., { overlay: false })` for provider-native `web_search` final result cards",
		];

		for (const snippet of forbiddenSnippets) {
			expect(combined).not.toContain(snippet);
		}
	});

	it("documents web_search live overlay lifecycle, timing defaults, and image_generation exclusion", async () => {
		const readme = await fs.readFile(path.join(import.meta.dir, "../README.md"), "utf8");
		const compatibility = await fs.readFile(path.join(import.meta.dir, "../docs/runtime-compatibility.md"), "utf8");
		const combined = `${readme}\n${compatibility}`;

		const requiredSnippets = [
			"counts `response.web_search_call.in_progress`, `response.web_search_call.searching`, and `response.web_search_call.completed`",
			"tracks `response.output_item.added` and `response.output_item.done`",
			"hides temporary provider IDs such as `res_...`, `resp_...`, or `unknown`",
			"collapse 3000 ms, hide 8000 ms, and auto-close 10000 ms",
			"final card delivery closes the active overlay only after the idle display send starts",
			"Provider-native `image_generation` does not use a live overlay and remains provider-native",
		];

		for (const snippet of requiredSnippets) {
			expect(combined).toContain(snippet);
		}

		expect(readme).not.toContain("短状态行");
		expect(readme).not.toContain("RPC mode 如果提供 `string[]` `setWidget`");
	});
});
