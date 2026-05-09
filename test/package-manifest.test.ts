import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import packageJson from "../package.json";

const runtimeCorePackages = [
	"@oh-my-pi/pi-coding-agent",
	"@mariozechner/pi-coding-agent",
	"@oh-my-pi/pi-ai",
	"@mariozechner/pi-ai",
	"@oh-my-pi/pi-agent-core",
	"@mariozechner/pi-agent-core",
];

const allowedRuntimeDependencies = ["yaml"];
const forbiddenRuntimePackageScopes = ["@oh-my-pi/", "@mariozechner/"];
const repoRoot = resolve(import.meta.dir, "..");
const licensePath = resolve(repoRoot, "LICENSE");
const readmePath = resolve(repoRoot, "README.md");
const currentReleaseNotesPath = resolve(repoRoot, `docs/release-notes-v${packageJson.version}.md`);

describe("package manifest", () => {
	it("declares both OMP and Pi extension entry points", () => {
		expect(packageJson.omp).toEqual({ extensions: ["./src/extension.ts"] });
		expect(packageJson.pi).toEqual({ extensions: ["./src/extension.ts"] });
	});

	it("exposes a Node-compatible CLI for explicit image agent configuration", () => {
		expect(packageJson.bin).toEqual({
			"omp-openai-provider-tools": "./src/cli.mjs",
		});
		expect(packageJson.files).toContain("src");
		expect(existsSync(resolve(repoRoot, "src/cli.mjs"))).toBe(true);
		expect(packageJson.engines.node).toBe(">=20");
	});

	it("declares MPL-2.0 licensing consistently", () => {
		expect(packageJson.license).toBe("MPL-2.0");
		expect(existsSync(licensePath)).toBe(true);
		expect(readFileSync(licensePath, "utf8")).toContain("Mozilla Public License Version 2.0");
		const readme = readFileSync(readmePath, "utf8");
		expect(readme).toContain("License: MPL-2.0");
		expect(readme).toContain("[MPL-2.0](./LICENSE)");
	});

	it("declares the GitHub repository for npm provenance", () => {
		expect(packageJson.repository).toEqual({
			type: "git",
			url: "git+https://github.com/jiwangyihao/omp-openai-provider-tools.git",
		});
	});

	it("documents the current package version for release", () => {
		const readme = readFileSync(readmePath, "utf8");
		expect(readme).toContain(`Latest in v${packageJson.version}`);
		expect(readme).toContain(`omp plugin install npm:omp-openai-provider-tools@${packageJson.version}`);
		expect(existsSync(currentReleaseNotesPath)).toBe(true);
		const releaseNotes = readFileSync(currentReleaseNotesPath, "utf8");
		expect(releaseNotes).toContain("- Version: `" + packageJson.version + "`");
		expect(releaseNotes).toContain("configure-image-agent");
	});

	it("does not document Sys-suffixed route ids in README examples", () => {
		const readme = readFileSync(readmePath, "utf8");
		expect(readme).not.toContain("-Sys");
	});

	it("explains runtime host-tool conflict handling and provider configuration", () => {
		const readme = readFileSync(readmePath, "utf8");
		expect(readme).toContain("安装插件本身不会禁用任何 OMP 原生工具");
		expect(readme).toContain("before_agent_start");
		expect(readme).toContain("before_provider_request");
		expect(readme).toContain("帮助用户配置 OpenAI 官方 provider");
		expect(readme).toContain("用户自己的 OpenAI-compatible 中转站");
	});

	it("documents explicit image agent CLI configuration", () => {
		const readme = readFileSync(readmePath, "utf8");
		expect(readme).toContain("configure-image-agent --model <image-capable-model-alias>");
		expect(readme).toContain("--model 必须由安装 Agent 根据用户实际 provider/model 配置填写");
		expect(readme).toContain("不会在插件安装时自动写入或覆盖用户的 agent 配置");
		expect(readme).toContain("主动收集项目上下文");
		expect(readme).toContain("最多主动再生成一次");
	});

	it("is discoverable as a Pi package and publishes runtime files", () => {
		expect(packageJson.keywords).toContain("pi-package");
		expect(packageJson.files).toEqual(["src", "README.md", "docs/runtime-compatibility.md"]);
		for (const fileEntry of packageJson.files) {
			expect(existsSync(resolve(repoRoot, fileEntry)), `${fileEntry} should exist before publishing`).toBe(true);
		}
	});

	it("excludes internal superpowers docs from published files", () => {
		expect(packageJson.files).not.toContain("docs");
		expect(packageJson.files.some((fileEntry) => fileEntry.startsWith("docs/superpowers"))).toBe(false);
	});

	it("limits runtime dependencies to portable packages", () => {
		expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual(allowedRuntimeDependencies);
		expect(Object.keys(packageJson.peerDependencies ?? {})).toEqual([]);

		for (const deps of [packageJson.dependencies ?? {}, packageJson.peerDependencies ?? {}]) {
			for (const packageName of runtimeCorePackages) {
				expect(deps).not.toHaveProperty(packageName);
			}

			for (const packageName of Object.keys(deps)) {
				expect(forbiddenRuntimePackageScopes.some((scope) => packageName.startsWith(scope))).toBe(false);
			}
		}
	});
});
