import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

describe("live status documentation", () => {
	it("documents provider web_search live status and image_generation exclusion", async () => {
		const readme = await fs.readFile(path.join(import.meta.dir, "../README.md"), "utf8");
		const compatibility = await fs.readFile(path.join(import.meta.dir, "../docs/runtime-compatibility.md"), "utf8");

		expect(readme).toContain("实时展示 provider-native `web_search` 状态");
		expect(readme).toContain("dashboard-style overlay");
		expect(readme).toContain("`message_end` / `agent_end`");
		expect(readme).toContain("does not fall back to the old short status widget");
		expect(readme).toContain("完成状态会短暂保留");
		expect(readme).toContain("回显出现时会立即关闭 overlay");
		expect(readme).toContain("`image_generation` 不显示实时 overlay");
		expect(compatibility).toContain("Live status overlay UI");
		expect(compatibility).toContain("ctx.ui.custom");
		expect(compatibility).toContain("no-op");
		expect(compatibility).toContain("Completed status auto-closes after a short delay");
		expect(compatibility).toContain("final result echo/lifecycle cleanup closes any active overlay immediately");
		expect(compatibility).toContain("Do not create live overlay status for provider-native `image_generation`");
		expect(readme).not.toContain("短状态行");
		expect(readme).not.toContain("RPC mode 如果提供 `string[]` `setWidget`");
	});
});
