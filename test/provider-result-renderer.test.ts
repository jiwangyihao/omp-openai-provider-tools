import { describe, expect, it } from "bun:test";

import { PROVIDER_TOOL_RESULT_MESSAGE_TYPE } from "../src/provider-results";
import { registerProviderToolResultRenderer } from "../src/provider-result-renderer";

interface FakeComponent {
	render(width: number): string[];
	invalidate(): void;
}

class FakeContainer implements FakeComponent {
	readonly children: FakeComponent[] = [];
	addChild(component: FakeComponent): void {
		this.children.push(component);
	}
	render(width: number): string[] {
		return this.children.flatMap(child => child.render(width));
	}
	invalidate(): void {}
}

class FakeBox extends FakeContainer {
	constructor(
		private readonly paddingX = 1,
		private readonly paddingY = 1,
		private readonly bgFn?: (text: string) => string,
	) {
		super();
	}
	clear(): void {
		this.children.splice(0);
	}
	render(width: number): string[] {
		const inner = super.render(Math.max(1, width - this.paddingX * 2));
		const padded = [
			...Array.from({ length: this.paddingY }, () => ""),
			...inner.map(line => `${" ".repeat(this.paddingX)}${line}`),
			...Array.from({ length: this.paddingY }, () => ""),
		];
		return this.bgFn ? padded.map(line => this.bgFn?.(line) ?? line) : padded;
	}
}

class FakeText implements FakeComponent {
	constructor(private readonly text = "") {}
	render(): string[] {
		return this.text ? this.text.split("\n") : [];
	}
	invalidate(): void {}
}

class FakeSpacer implements FakeComponent {
	constructor(private readonly height = 1) {}
	render(): string[] {
		return Array.from({ length: this.height }, () => "");
	}
	invalidate(): void {}
}

const fakeTui = {
	Box: FakeBox,
	Text: FakeText,
	Spacer: FakeSpacer,
};

function testTheme() {
	return {
		fg(key: string, value: string) {
			return `FG(${key}:${value})`;
		},
		bg(key: string, value: string) {
			return `BG(${key}:${value})`;
		},
		bold(value: string) {
			return `BOLD(${value})`;
		},
	};
}

function renderProviderResult(expanded: boolean, message: unknown): string {
	const renderers = new Map<string, Function>();
	registerProviderToolResultRenderer({
		registerMessageRenderer(customType: string, renderer: Function) {
			renderers.set(customType, renderer);
		},
	}, fakeTui);
	const renderer = renderers.get(PROVIDER_TOOL_RESULT_MESSAGE_TYPE);
	expect(renderer).toBeDefined();
	const component = renderer!(message, { expanded }, testTheme());
	return component?.render(96).join("\n") ?? "";
}

function webSearchMessage() {
	return {
		customType: PROVIDER_TOOL_RESULT_MESSAGE_TYPE,
		display: true,
		attribution: "agent",
		content: "",
		details: {
			type: "web_search",
			queries: ["provider native image_generation", "latest OMP provider tools"],
			citations: [{ title: "Provider Tools", url: "https://example.invalid/provider-tools" }],
			sources: [{ url: "https://example.invalid/source" }],
			results: [{ type: "web_search", status: "completed" }],
		},
	};
}

describe("provider tool result renderer", () => {
	it("renders web_search details from metadata while content remains agent-invisible", () => {
		const message = webSearchMessage();

		const folded = renderProviderResult(false, message);
		const expanded = renderProviderResult(true, message);

		expect(message.content).toBe("");
		expect(folded).toContain("BG(customMessageBg:");
		expect(folded).toContain("FG(customMessageLabel:BOLD([openai-provider-tool-result]))");
		expect(folded).toContain("OpenAI provider completed web_search (1 call).");
		expect(folded).toContain("[(Ctrl+O for more)]");
		expect(folded).not.toContain("https://example.invalid/provider-tools");
		expect(expanded).toContain("Queries: provider native image_generation; latest OMP provider tools");
		expect(expanded).toContain("Provider Tools: https://example.invalid/provider-tools");
		expect(expanded).not.toContain("[(Ctrl+O for more)]");
	});
});
