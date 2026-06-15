import { describe, expect, it } from "bun:test";

import { PROVIDER_TOOL_RESULT_MESSAGE_TYPE } from "../src/provider-results";
import { createProviderToolResultCardComponent, createProviderToolResultCardFactory, registerProviderToolResultRenderer } from "../src/provider-result-renderer";

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

function webSearchMessageWithActionDetails() {
	return {
		customType: PROVIDER_TOOL_RESULT_MESSAGE_TYPE,
		display: true,
		attribution: "agent",
		content: "",
		details: {
			summary: "OpenAI provider completed web_search (2 calls).",
			type: "web_search",
			queries: ["provider result renderer action details"],
			citations: [{ title: "Citation Title", url: "https://example.invalid/citation" }],
			sources: [{ url: "https://example.invalid/source" }],
			actionDetails: [
				{ type: "open_page", label: "url", value: "https://example.invalid/page" },
				{ type: "find_in_page", label: "pattern", value: "needle pattern" },
			],
			results: [
				{ type: "web_search", status: "completed" },
				{ type: "web_search", status: "completed" },
			],
		},
	};
}

function outerDisplayMessage(message = webSearchMessageWithActionDetails()) {
	return {
		role: "custom",
		customType: PROVIDER_TOOL_RESULT_MESSAGE_TYPE,
		content: "OpenAI provider web_search result",
		display: true,
		details: {
			uiOnly: true,
			source: "omp-openai-provider-tools",
			resultKey: "session-1:web_search:ws-1",
			message,
		},
	};
}

describe("provider tool result renderer", () => {
	it("loads TUI lazily after the first render without a runtime override", async () => {
		const renderers = new Map<string, Function>();
		let loadCalls = 0;
		registerProviderToolResultRenderer(
			{
				registerMessageRenderer(customType: string, renderer: Function) {
					renderers.set(customType, renderer);
				},
			},
			undefined,
			async () => {
				loadCalls++;
				return fakeTui;
			},
		);

		const renderer = renderers.get(PROVIDER_TOOL_RESULT_MESSAGE_TYPE);
		expect(renderer).toBeDefined();
		expect(loadCalls).toBe(0);

		const firstRender = renderer!(webSearchMessage(), { expanded: false }, testTheme());
		expect(firstRender).toBeUndefined();
		expect(loadCalls).toBe(1);

		await new Promise(resolve => setTimeout(resolve, 0));

		const secondRender = renderer!(webSearchMessage(), { expanded: false }, testTheme());
		expect(secondRender?.render(96).join("\n")).toContain("OpenAI provider completed web_search (1 call).");
	});

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

	it("renders provider result cards through the same collapsed renderer as custom messages", () => {
		const component = createProviderToolResultCardFactory(webSearchMessage() as any, fakeTui)({}, testTheme());
		const rendered = component.render(96).join("\n");

		expect(rendered).toContain("OpenAI provider completed web_search (1 call).");
		expect(rendered).toContain("[(Ctrl+O for more)]");
		expect(rendered).not.toContain("https://example.invalid/provider-tools");
	});

	it("uses the original renderer expansion contract for provider result details", () => {
		const folded = createProviderToolResultCardFactory(webSearchMessage() as any, fakeTui)({}, testTheme()).render(96).join("\n");
		const expanded = renderProviderResult(true, webSearchMessage());

		expect(folded).toContain("[(Ctrl+O for more)]");
		expect(folded).not.toContain("Provider Tools: https://example.invalid/provider-tools");
		expect(expanded).toContain("Provider Tools: https://example.invalid/provider-tools");
		expect(expanded).toContain("https://example.invalid/source");
	});

	it("toggles provider result card details with Ctrl+O", () => {
		const component = createProviderToolResultCardFactory(webSearchMessage() as any, fakeTui)({}, testTheme(), {
			matches(data: string, keybinding: string) {
				return data === "ctrl-o" && keybinding === "app.tools.expand";
			},
		});

		expect(component.render(96).join("\n")).not.toContain("Provider Tools: https://example.invalid/provider-tools");
		component.handleInput?.("ctrl-o");
		expect(component.render(96).join("\n")).toContain("Provider Tools: https://example.invalid/provider-tools");
		component.handleInput?.("ctrl-o");
		expect(component.render(96).join("\n")).not.toContain("Provider Tools: https://example.invalid/provider-tools");
	});

	it("creates a reusable provider result card component with setExpanded support", () => {
		const message = webSearchMessageWithActionDetails();

		const component = createProviderToolResultCardComponent(message as any, fakeTui, testTheme());

		expect(component).toBeDefined();
		expect(typeof component.setExpanded).toBe("function");
		const collapsed = component.render(120).join("\n");
		expect(collapsed).toContain("OpenAI provider completed web_search (2 calls).");
		expect(collapsed).toContain("[(Ctrl+O for more)]");
		expect(collapsed).not.toContain("https://example.invalid/page");
		expect(collapsed).not.toContain("needle pattern");

		component.setExpanded?.(true);
		const expanded = component.render(120).join("\n");
		expect(expanded).toContain("Queries: provider result renderer action details");
		expect(expanded).toContain("Citation Title: https://example.invalid/citation");
		expect(expanded).toContain("https://example.invalid/source");
		expect(expanded).toContain("open_page url: https://example.invalid/page");
		expect(expanded).toContain("find_in_page pattern: needle pattern");
		expect(expanded).not.toContain("[(Ctrl+O for more)]");

		component.setExpanded?.(false);
		const collapsedAgain = component.render(120).join("\n");
		expect(collapsedAgain).toContain("[(Ctrl+O for more)]");
		expect(collapsedAgain).not.toContain("https://example.invalid/page");
	});

	it("renders nested provider result payloads from idle-gated display messages", () => {
		const folded = renderProviderResult(false, outerDisplayMessage());
		const expanded = renderProviderResult(true, outerDisplayMessage());

		expect(folded).toContain("OpenAI provider completed web_search (2 calls).");
		expect(folded).toContain("[(Ctrl+O for more)]");
		expect(folded).not.toContain("https://example.invalid/page");
		expect(expanded).toContain("Queries: provider result renderer action details");
		expect(expanded).toContain("open_page url: https://example.invalid/page");
		expect(expanded).toContain("find_in_page pattern: needle pattern");
	});

	it("keeps final provider result cards in chat history for q and Esc inputs", () => {
		const component = createProviderToolResultCardComponent(webSearchMessageWithActionDetails() as any, fakeTui, testTheme());

		const before = component.render(120).join("\n");
		component.handleInput?.("q");
		expect(component.render(120).join("\n")).toBe(before);
		component.handleInput?.("\x1b");
		expect(component.render(120).join("\n")).toBe(before);

		component.setExpanded?.(true);
		expect(component.render(120).join("\n")).toContain("https://example.invalid/page");
	});
});
