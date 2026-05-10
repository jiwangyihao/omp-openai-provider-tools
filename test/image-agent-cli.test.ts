import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderImageAgentTemplate, runCli } from "../src/cli.mjs";

const cliSource = readFileSync(new URL("../src/cli.mjs", import.meta.url), "utf8");

function createCapture() {
	let stdout = "";
	let stderr = "";
	return {
		stdout: { write: (chunk: string) => { stdout += chunk; } },
		stderr: { write: (chunk: string) => { stderr += chunk; } },
		get stdoutText() { return stdout; },
		get stderrText() { return stderr; },
	};
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "omp-openai-provider-tools-cli-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("image agent CLI", () => {
	it("uses a Node-compatible shebang for npx execution", () => {
		expect(cliSource.startsWith("#!/usr/bin/env node\n")).toBe(true);
	});

	it("renders a context-gathering image agent for the supplied model", () => {
		const template = renderImageAgentTemplate({
			agentName: "image_generator",
			model: "custom-provider/image-model",
			thinkingLevel: "xhigh",
		});

		expect(template).toContain("name: image_generator");
		expect(template).toContain("model: \"custom-provider/image-model\"");
		expect(template).toContain("thinkingLevel: xhigh");
		expect(template).toContain("  - read");
		expect(template).toContain("  - find");
		expect(template).toContain("  - search");
		expect(template).toContain("  - yield");
		expect(template).toContain("主动收集上下文");
		expect(template).toContain("最多主动再生成一次");
		expect(template).toContain("必须调用 provider-native `image_generation` 工具作为最终产物");
		expect(template).toContain("禁止只返回提示词");
		expect(template).toContain("如果你能看到 image_generation 或 image_gen.imagegen，必须调用它");
		expect(template).not.toContain("-Sys");
	});

	it("requires Agent installers to provide the actual image-capable model", async () => {
		await withTempDir(async (dir) => {
			const capture = createCapture();
			const exitCode = await runCli(["configure-image-agent", "--agent-dir", dir], capture);

			expect(exitCode).toBe(2);
			expect(capture.stderrText).toContain("--model");
		});
	});

	it("rejects unsafe agent names before writing files", async () => {
		await withTempDir(async (dir) => {
			const capture = createCapture();
			const exitCode = await runCli([
				"configure-image-agent",
				"--model",
				"custom-provider/image-model",
				"--agent",
				"../evil",
				"--agent-dir",
				dir,
			], capture);

			expect(exitCode).toBe(2);
			expect(capture.stderrText).toContain("--agent");
			expect(existsSync(join(dir, "evil.md"))).toBe(false);
		});
	});

	it("rejects unsupported thinking levels", async () => {
		await withTempDir(async (dir) => {
			const capture = createCapture();
			const exitCode = await runCli([
				"configure-image-agent",
				"--model",
				"custom-provider/image-model",
				"--thinking",
				"ultra",
				"--agent-dir",
				dir,
			], capture);

			expect(exitCode).toBe(2);
			expect(capture.stderrText).toContain("--thinking");
		});
	});

	it("prints the configured template without writing files", async () => {
		await withTempDir(async (dir) => {
			const capture = createCapture();
			const exitCode = await runCli([
				"configure-image-agent",
				"--model",
				"custom-provider/image-model",
				"--agent-dir",
				dir,
				"--print",
			], capture);

			expect(exitCode).toBe(0);
			expect(capture.stdoutText).toContain("model: \"custom-provider/image-model\"");
			expect(existsSync(join(dir, "image-generator.md"))).toBe(false);
		});
	});

	it("writes the agent file and refuses accidental overwrites", async () => {
		await withTempDir(async (dir) => {
			const first = createCapture();
			const firstExit = await runCli([
				"configure-image-agent",
				"--model",
				"custom-provider/image-model",
				"--agent-dir",
				dir,
			], first);
			const agentPath = join(dir, "image-generator.md");

			expect(firstExit).toBe(0);
			expect(await readFile(agentPath, "utf8")).toContain("model: \"custom-provider/image-model\"");

			const second = createCapture();
			const secondExit = await runCli([
				"configure-image-agent",
				"--model",
				"custom-provider/other-model",
				"--agent-dir",
				dir,
			], second);

			expect(secondExit).toBe(2);
			expect(second.stderrText).toContain("already exists");
			expect(await readFile(agentPath, "utf8")).toContain("model: \"custom-provider/image-model\"");
		});
	});

	it("allows explicit force overwrites", async () => {
		await withTempDir(async (dir) => {
			const agentPath = join(dir, "image-generator.md");
			await writeFile(agentPath, "old content", "utf8");

			const capture = createCapture();
			const exitCode = await runCli([
				"configure-image-agent",
				"--model",
				"custom-provider/image-model",
				"--agent-dir",
				dir,
				"--force",
			], capture);

			expect(exitCode).toBe(0);
			expect(await readFile(agentPath, "utf8")).toContain("model: \"custom-provider/image-model\"");
		});
	});
});
