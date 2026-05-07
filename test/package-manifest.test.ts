import { describe, expect, it } from "bun:test";
import packageJson from "../package.json";

const runtimeCorePackages = [
	"@oh-my-pi/pi-coding-agent",
	"@mariozechner/pi-coding-agent",
	"@oh-my-pi/pi-ai",
	"@mariozechner/pi-ai",
	"@oh-my-pi/pi-agent-core",
	"@mariozechner/pi-agent-core",
];

describe("package manifest", () => {
	it("declares both OMP and Pi extension entry points", () => {
		expect(packageJson.omp).toEqual({ extensions: ["./src/extension.ts"] });
		expect(packageJson.pi).toEqual({ extensions: ["./src/extension.ts"] });
	});

	it("is discoverable as a Pi package and publishes runtime files", () => {
		expect(packageJson.keywords).toContain("pi-package");
		expect(packageJson.files).toEqual(expect.arrayContaining(["src", "README.md", "docs"]));
	});

	it("does not depend on OMP or Pi runtime packages", () => {
		for (const deps of [packageJson.dependencies ?? {}, packageJson.peerDependencies ?? {}]) {
			for (const packageName of runtimeCorePackages) {
				expect(deps).not.toHaveProperty(packageName);
			}
		}
	});
});
