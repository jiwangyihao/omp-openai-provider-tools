import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

const repoRoot = resolve(import.meta.dir, "..");
const workflowPath = resolve(repoRoot, ".github/workflows/release.yml");
const publishingDocPath = resolve(repoRoot, "docs/publishing.md");

function readText(path: string): string {
	return readFileSync(path, "utf8");
}


function stepByName(steps: any[], name: string): any {
	const step = steps.find(entry => entry?.name === name);
	expect(step, `workflow step ${name} should exist`).toBeDefined();
	return step;
}
describe("release publishing configuration", () => {
	it("publishes to npm from a GitHub Release with trusted publishing permissions", () => {
		expect(existsSync(workflowPath)).toBe(true);
		const workflowText = readText(workflowPath);
		const workflow = YAML.parse(workflowText) as any;

		expect(workflow.name).toBe("Release");
		expect(workflow.on).toEqual({ release: { types: ["published"] } });
		expect(workflow.permissions).toEqual({ contents: "read", "id-token": "write" });

		const job = workflow.jobs["publish-npm"];
		expect(job["runs-on"]).toBe("ubuntu-latest");
		expect(job.env).toEqual({ NODE_AUTH_TOKEN: "" });

		const steps = job.steps as any[];
		expect(stepByName(steps, "Checkout").uses).toBe("actions/checkout@v4");

		const setupNode = stepByName(steps, "Setup Node");
		expect(setupNode.uses).toBe("actions/setup-node@v4");
		expect(String(setupNode.with["node-version"])).toBe("24");
		expect(setupNode.with["registry-url"]).toBe("https://registry.npmjs.org");

		expect(stepByName(steps, "Upgrade npm for trusted publishing").run).toBe("npm install -g npm@latest");
		expect(stepByName(steps, "Setup Bun").uses).toBe("oven-sh/setup-bun@v2");
		expect(stepByName(steps, "Install").run).toBe("bun install --frozen-lockfile");
		expect(stepByName(steps, "Test").run).toBe("bun test");
		expect(stepByName(steps, "Pack dry run").run).toBe("npm pack --dry-run --json");

		const versionCheck = stepByName(steps, "Check if version already published");
		expect(versionCheck.id).toBe("npm");
		expect(versionCheck.run).toContain("npm view \"${NAME}@${VERSION}\" version");
		expect(versionCheck.run).toContain("published=true");

		const publish = stepByName(steps, "Publish");
		expect(publish.if).toBe("steps.npm.outputs.published != 'true'");
		expect(publish.run).toBe("npm publish --access public");
	});

	it("documents manual first publish and trusted publisher setup for this package", () => {
		expect(existsSync(publishingDocPath)).toBe(true);
		const doc = readText(publishingDocPath);

		expect(doc).toContain("omp-openai-provider-tools 发布流程");
		expect(doc).toContain("bun test");
		expect(doc).toContain("npm pack --dry-run --json");
		expect(doc).toContain("npm view omp-openai-provider-tools");
		expect(doc).toContain("npm publish --access public");
		expect(doc).toContain("npx --yes npm@latest trust github omp-openai-provider-tools");
		expect(doc).toContain(".github/workflows/release.yml");
		expect(doc).toContain("gh release create");
	});
});
