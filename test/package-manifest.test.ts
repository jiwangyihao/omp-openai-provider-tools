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

describe("package manifest", () => {
	it("declares both OMP and Pi extension entry points", () => {
		expect(packageJson.omp).toEqual({ extensions: ["./src/extension.ts"] });
		expect(packageJson.pi).toEqual({ extensions: ["./src/extension.ts"] });
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
