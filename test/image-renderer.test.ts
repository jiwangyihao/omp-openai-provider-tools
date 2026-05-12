import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { PROVIDER_IMAGE_MESSAGE_TYPE } from "../src/image-results";
import { registerProviderImageRenderer, runtimeTuiSpecifiers } from "../src/image-renderer";

const ONE_BY_ONE_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

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

class FakeImage implements FakeComponent {
	constructor(
		private readonly _base64Data: string,
		private readonly mimeType: string,
		private readonly _theme: unknown,
		private readonly options?: { filename?: string },
	) {}
	render(): string[] {
		return [`[Image: ${this.options?.filename ?? "image"} [${this.mimeType}]]`];
	}
	invalidate(): void {}
}

class FakeProtocolImage implements FakeComponent {
	constructor(
		private readonly _base64Data: string,
		private readonly _mimeType: string,
		private readonly _theme: unknown,
		private readonly _options?: { filename?: string },
	) {}
	render(): string[] {
		return ["", "", "", "\x1b[2A\x1bPqFAKE_DIRECT_IMAGE"];
	}
	invalidate(): void {}
}


class FakeRuntimeAssistantMessage implements FakeComponent {
	private images: Array<{ data: string; mimeType: string }> = [];
	constructor(private readonly _message?: unknown) {}
	setToolResultImages(_toolCallId: string, images: Array<{ data: string; mimeType: string }>): void {
		this.images = images;
	}
	render(): string[] {
		return this.images.map(image => `RUNTIME_IMAGE:${image.mimeType}:${image.data.slice(0, 12)}`);
	}
	invalidate(): void {}
}

class FakeRuntimeAssistantMessageWithImageRows extends FakeRuntimeAssistantMessage {
	render(): string[] {
		return super.render().flatMap(line => ["", "", line]);
	}
}

class FakeRuntimeAssistantMessageWithTrailingBlankRows extends FakeRuntimeAssistantMessage {
	render(): string[] {
		return super.render().flatMap(line => [line, "   ", "\t"]);
	}
}

class FakeRuntimeAssistantMessageWithCursorImage extends FakeRuntimeAssistantMessage {
	render(): string[] {
		return super.render().flatMap(() => ["", "", "", "\x1b[2A\x1bPqFAKE_SIXEL_IMAGE"]);
	}
}

class FakeRuntimeAssistantMessageWithDirtyProtocolRows extends FakeRuntimeAssistantMessage {
	render(): string[] {
		return super.render().flatMap(() => ["", "", "", "\x1b[2A\x1bPqFAKE_SIXEL_IMAGE", "   ", "\t"]);
	}
}

class FakeRuntimeAssistantMessageWithTwoCursorImages implements FakeComponent {
	private images: Array<{ data: string; mimeType: string }> = [];
	constructor(private readonly _message?: unknown) {}
	setToolResultImages(_toolCallId: string, images: Array<{ data: string; mimeType: string }>): void {
		this.images = images;
	}
	render(): string[] {
		return this.images.flatMap((_image, index) => ["", "", "", `\x1b[2A\x1bPqFAKE_SIXEL_IMAGE_${index}`]);
	}
	invalidate(): void {}
}


const fakeTui = {
	Container: FakeContainer,
	Box: FakeBox,
	Text: FakeText,
	Spacer: FakeSpacer,
	Image: FakeImage,
};

const fakeTuiWithoutImage = {
	Container: FakeContainer,
	Box: FakeBox,
	Text: FakeText,
	Spacer: FakeSpacer,
};

const fakeTuiWithProtocolImage = {
	Container: FakeContainer,
	Box: FakeBox,
	Text: FakeText,
	Spacer: FakeSpacer,
	Image: FakeProtocolImage,
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

async function makeImageMessage() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-provider-image-renderer-"));
	tempDirs.push(dir);
	const imagePath = path.join(dir, "provider-result.png");
	await fs.writeFile(imagePath, Buffer.from(ONE_BY_ONE_PNG, "base64"));
	return {
		customType: PROVIDER_IMAGE_MESSAGE_TYPE,
		display: true,
		attribution: "agent",
		content: [
			{ type: "text", text: `OpenAI provider generated 1 image.\nSaved image path: ${imagePath}\nUse the attached image when editing this generation.` },
			{ type: "image", data: ONE_BY_ONE_PNG, mimeType: "image/png" },
		],
		details: {
			path: imagePath,
			mimeType: "image/png",
			summary: "OpenAI provider generated 1 image.",
			images: [
				{
					id: "ig_123",
					path: imagePath,
					bytes: 68,
					mimeType: "image/png",
					outputFormat: "png",
					quality: "high",
					size: "1024x1024",
					revisedPrompt: "A tiny blue square cat.",
					sha256: "abc123",
					reusedExisting: false,
				},
			],
		},
	};
}

function renderMessage(expanded: boolean, message: unknown, apiOverrides: Record<string, unknown> = {}, tui = fakeTui): string {
	const renderers = new Map<string, Function>();
	registerProviderImageRenderer({
		registerMessageRenderer(customType: string, renderer: Function) {
			renderers.set(customType, renderer);
		},
		logger: { warn() {} },
		...apiOverrides,
	}, tui);
	const renderer = renderers.get(PROVIDER_IMAGE_MESSAGE_TYPE);
	expect(renderer).toBeDefined();
	const component = renderer!(message, { expanded }, testTheme());
	return component?.render(96).join("\n") ?? "";
}

describe("provider image renderer", () => {
	it("wraps provider image messages in the native custom-message background", async () => {
		const message = await makeImageMessage();

		const expanded = renderMessage(true, message);

		expect(expanded).toContain("BG(customMessageBg:");
		expect(expanded).toContain("FG(customMessageLabel:BOLD([openai-provider-image-generation]))");
		expect(expanded).toContain("FG(customMessageText:OpenAI provider generated 1 image.");
	});

	it("shows an image preview when folded and adds concise metadata when expanded", async () => {
		const message = await makeImageMessage();
		const imagePath = ((message.details as any).images[0] as any).path as string;

		const folded = renderMessage(false, message);
		const expanded = renderMessage(true, message);

		expect(folded).toContain("[Image: provider-result.png [image/png]");
		expect(folded).toContain("[(Ctrl+O for more)]");
		expect(folded).toContain("FG(customMessageLabel:BOLD([openai-provider-image-generation]))");
		expect(folded).not.toContain("OpenAI provider generated 1 image.");
		expect(folded).not.toContain(imagePath);
		expect(folded).not.toContain("SHA-256:");
		expect(expanded).toContain("[Image: provider-result.png [image/png]");
		expect(expanded).toContain("File: provider-result.png");
		expect(expanded).toContain("Bytes: 68");
		expect(expanded).toContain("SHA-256: abc123");
		expect(expanded).toContain("Revised prompt: A tiny blue square cat.");
		expect(expanded).not.toContain(imagePath);
	});

	it("does not leak full paths when image preview fallback is used", async () => {
		const message = await makeImageMessage();
		const imagePath = ((message.details as any).images[0] as any).path as string;

		const folded = renderMessage(false, message, {}, fakeTuiWithoutImage);
		const expanded = renderMessage(true, message, {}, fakeTuiWithoutImage);

		expect(folded).toContain("provider-result.png");
		expect(folded).not.toContain(imagePath);
		expect(expanded).toContain("provider-result.png");
		expect(expanded).not.toContain(imagePath);
	});

	it("uses the runtime assistant image renderer when the OMP runtime exports it", async () => {
		const message = await makeImageMessage();

		const folded = renderMessage(false, message, {
			pi: {
				AssistantMessageComponent: FakeRuntimeAssistantMessage,
			},
		});

		expect(folded).toContain("BG(customMessageBg:");
		expect(folded).toContain("RUNTIME_IMAGE:image/png:iVBORw0KGgoA");
		expect(folded).not.toContain("[Image: provider-result.png [image/png]");
		expect(folded).toContain("[(Ctrl+O for more)]");
		expect(folded).toContain("FG(customMessageLabel:BOLD([openai-provider-image-generation]))");
		expect(folded).not.toContain("OpenAI provider generated 1 image.");
		const expanded = renderMessage(true, message, {
			pi: {
				AssistantMessageComponent: FakeRuntimeAssistantMessage,
			},
		});
		const imagePath = ((message.details as any).images[0] as any).path as string;
		const lines = folded.split("\n");
		const imageLineIndex = lines.findIndex(line => line.includes("RUNTIME_IMAGE:image/png:iVBORw0KGgoA"));
		expect(imageLineIndex).toBeGreaterThan(0);
		expect(expanded).toContain("RUNTIME_IMAGE:image/png:iVBORw0KGgoA");
		expect(expanded).toContain("File: provider-result.png");
		expect(expanded).toContain("SHA-256: abc123");
		expect(expanded).not.toContain(imagePath);
	});


	it("background-fills runtime image rows without a fold hint that can accumulate", async () => {
		const message = await makeImageMessage();

		const folded = renderMessage(false, message, {
			pi: {
				AssistantMessageComponent: FakeRuntimeAssistantMessageWithImageRows,
			},
		});
		const lines = folded.split("\n");
		const imageLineIndex = lines.findIndex(line => line.includes("RUNTIME_IMAGE:image/png:iVBORw0KGgoA"));

		expect((folded.match(/Ctrl\+O for more/g) ?? [])).toHaveLength(1);
		expect(imageLineIndex).toBeGreaterThan(1);
		expect(lines.some(line => line === "")).toBe(false);
		expect(lines[imageLineIndex - 1]).toContain("BG(customMessageBg:");
		expect(lines.at(-1)).toBe("RUNTIME_IMAGE:image/png:iVBORw0KGgoA");
	});

	it("background-fills trailing runtime blank rows under the image", async () => {
		const message = await makeImageMessage();

		const folded = renderMessage(false, message, {
			pi: {
				AssistantMessageComponent: FakeRuntimeAssistantMessageWithTrailingBlankRows,
			},
		});
		const lines = folded.split("\n");
		const imageLineIndex = lines.findIndex(line => line.includes("RUNTIME_IMAGE:image/png:iVBORw0KGgoA"));

		expect(imageLineIndex).toBeGreaterThan(0);
		expect(lines[imageLineIndex]).toBe("RUNTIME_IMAGE:image/png:iVBORw0KGgoA");
		expect(lines[imageLineIndex + 1]).toContain("BG(customMessageBg:");
		expect(lines[imageLineIndex + 2]).toContain("BG(customMessageBg:");
		expect(lines[imageLineIndex + 1]).not.toBe("   ");
		expect(lines[imageLineIndex + 2]).not.toBe("\t");
	});

	it("renders expanded details before an isolated runtime image block", async () => {
		const message = await makeImageMessage();

		const folded = renderMessage(false, message, {
			pi: {
				AssistantMessageComponent: FakeRuntimeAssistantMessageWithCursorImage,
			},
		});
		const foldedLines = folded.split("\n");
		const foldedImageLineIndex = foldedLines.findIndex(line => line.includes("FAKE_SIXEL_IMAGE"));

		expect(folded).toContain("[(Ctrl+O for more)]");
		const foldedLabelIndex = foldedLines.findIndex(line => line.includes("[openai-provider-image-generation]"));
		expect(foldedLabelIndex).toBeGreaterThanOrEqual(0);
		expect(foldedLines[foldedLabelIndex + 1]).toContain("Ctrl+O for more");
		expect(foldedLines[foldedLabelIndex + 2]).toContain("BG(customMessageBg:");
		expect(foldedImageLineIndex).toBe(foldedLines.length - 1);
		expect(foldedLines[foldedImageLineIndex]).toBe("\x1b[2A\x1bPqFAKE_SIXEL_IMAGE");

		const expanded = renderMessage(true, message, {
			pi: {
				AssistantMessageComponent: FakeRuntimeAssistantMessageWithCursorImage,
			},
		});
		const expandedLines = expanded.split("\n");
		const expandedImageLineIndex = expandedLines.findIndex(line => line.includes("FAKE_SIXEL_IMAGE"));

		expect(expanded).toContain("OpenAI provider generated 1 image.");
		expect(expanded).toContain("SHA-256: abc123");
		expect(expandedImageLineIndex).toBe(expandedLines.length - 1);
		expect(expandedLines[expandedImageLineIndex]).toBe("\x1b[2A\x1bPqFAKE_SIXEL_IMAGE");
		expect(expandedLines.findIndex(line => line.includes("SHA-256: abc123"))).toBeLessThan(expandedImageLineIndex);
	});

	it("preserves placeholder rows for each runtime image protocol block", async () => {
		const message = await makeImageMessage();
		(message.details as any).images.push({ ...((message.details as any).images[0] as any), id: "ig_456" });

		const folded = renderMessage(false, message, {
			pi: {
				AssistantMessageComponent: FakeRuntimeAssistantMessageWithTwoCursorImages,
			},
		});
		const lines = folded.split("\n");
		const firstImageLineIndex = lines.findIndex(line => line.includes("FAKE_SIXEL_IMAGE_0"));
		const secondImageLineIndex = lines.findIndex(line => line.includes("FAKE_SIXEL_IMAGE_1"));

		expect(firstImageLineIndex).toBeGreaterThan(0);
		expect(secondImageLineIndex).toBeGreaterThan(firstImageLineIndex);
		expect(lines[firstImageLineIndex + 1]).toContain("BG(customMessageBg:");
		expect(lines[firstImageLineIndex + 2]).toContain("BG(customMessageBg:");
		expect(lines[secondImageLineIndex - 1]).toContain("BG(customMessageBg:");
		expect(lines[secondImageLineIndex]).toBe("\x1b[2A\x1bPqFAKE_SIXEL_IMAGE_1");
		expect(secondImageLineIndex).toBe(lines.length - 1);
	});

	it("keeps raw protocol lines outside background while background-filling reserved image rows", async () => {
		const message = await makeImageMessage();

		const folded = renderMessage(false, message, {
			pi: {
				AssistantMessageComponent: FakeRuntimeAssistantMessageWithCursorImage,
			},
		});
		const lines = folded.split("\n");
		const imageLineIndex = lines.findIndex(line => line.includes("FAKE_SIXEL_IMAGE"));

		expect(imageLineIndex).toBeGreaterThan(2);
		expect(lines[imageLineIndex]).toBe("\x1b[2A\x1bPqFAKE_SIXEL_IMAGE");
		expect(lines[imageLineIndex]).not.toContain("BG(customMessageBg:");
		expect(lines[imageLineIndex - 1]).toContain("BG(customMessageBg:");
		expect(lines[imageLineIndex - 2]).toContain("BG(customMessageBg:");
		expect(lines[imageLineIndex + 1]).toBeUndefined();
	});

	it("keeps each multi-image protocol line raw while preserving background gaps", async () => {
		const message = await makeImageMessage();
		(message.details as any).images.push({ ...((message.details as any).images[0] as any), id: "ig_456" });

		const folded = renderMessage(false, message, {
			pi: {
				AssistantMessageComponent: FakeRuntimeAssistantMessageWithTwoCursorImages,
			},
		});
		const lines = folded.split("\n");
		const firstImageLineIndex = lines.findIndex(line => line.includes("FAKE_SIXEL_IMAGE_0"));
		const secondImageLineIndex = lines.findIndex(line => line.includes("FAKE_SIXEL_IMAGE_1"));

		expect(firstImageLineIndex).toBeGreaterThan(2);
		expect(secondImageLineIndex).toBeGreaterThan(firstImageLineIndex);
		expect(lines[firstImageLineIndex]).toBe("\x1b[2A\x1bPqFAKE_SIXEL_IMAGE_0");
		expect(lines[secondImageLineIndex]).toBe("\x1b[2A\x1bPqFAKE_SIXEL_IMAGE_1");
		expect(lines[firstImageLineIndex]).not.toContain("BG(customMessageBg:");
		expect(lines[secondImageLineIndex]).not.toContain("BG(customMessageBg:");
		expect(lines[firstImageLineIndex - 1]).toContain("BG(customMessageBg:");
		expect(lines[firstImageLineIndex - 2]).toContain("BG(customMessageBg:");
		expect(lines[secondImageLineIndex - 1]).toContain("BG(customMessageBg:");
		expect(lines[secondImageLineIndex - 2]).toContain("BG(customMessageBg:");
	});

	it("removes trailing blank rows after raw protocol output", async () => {
		const message = await makeImageMessage();

		const folded = renderMessage(false, message, {
			pi: {
				AssistantMessageComponent: FakeRuntimeAssistantMessageWithDirtyProtocolRows,
			},
		});
		const lines = folded.split("\n");
		const imageLineIndex = lines.findIndex(line => line.includes("FAKE_SIXEL_IMAGE"));

		expect(imageLineIndex).toBeGreaterThan(2);
		expect(lines[imageLineIndex]).toBe("\x1b[2A\x1bPqFAKE_SIXEL_IMAGE");
		expect(lines[imageLineIndex + 1]).toBeUndefined();
		expect(lines.some(line => line === "   " || line === "\t")).toBe(false);
	});

	it("keeps direct Tui.Image protocol output raw while retaining background placeholders", async () => {
		const message = await makeImageMessage();

		const folded = renderMessage(false, message, {}, fakeTuiWithProtocolImage);
		const lines = folded.split("\n");
		const imageLineIndex = lines.findIndex(line => line.includes("FAKE_DIRECT_IMAGE"));

		expect(imageLineIndex).toBeGreaterThan(2);
		expect(lines[imageLineIndex]).toBe("\x1b[2A\x1bPqFAKE_DIRECT_IMAGE");
		expect(lines[imageLineIndex]).not.toContain("BG(customMessageBg:");
		expect(lines[imageLineIndex - 1]).toContain("BG(customMessageBg:");
		expect(lines[imageLineIndex - 2]).toContain("BG(customMessageBg:");
	});

	it("prefers the runtime-matching pi-tui cache module before stale cached versions", async () => {
		const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-provider-tui-cache-"));
		tempDirs.push(cacheRoot);
		const scopeDir = path.join(cacheRoot, "@oh-my-pi");
		for (const version of ["14.7.3", "14.7.7", "14.7.6"]) {
			const srcDir = path.join(scopeDir, `pi-tui@${version}@@@1`, "src");
			await fs.mkdir(srcDir, { recursive: true });
			await fs.writeFile(path.join(srcDir, "index.ts"), "export {};\n");
		}

		const specifiers = runtimeTuiSpecifiers("14.7.7", cacheRoot);

		expect(specifiers[0]).toBe("@oh-my-pi/pi-tui");
		expect(specifiers[1]).toBe("@mariozechner/pi-tui");
		expect(specifiers[2]).toContain("pi-tui@14.7.7@@@1");
		expect(specifiers.join("\n").indexOf("pi-tui@14.7.7@@@1")).toBeLessThan(
			specifiers.join("\n").indexOf("pi-tui@14.7.6@@@1"),
		);
	});

	it("normalizes OMP-prefixed runtime versions before sorting cache modules", async () => {
		const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-provider-tui-cache-"));
		tempDirs.push(cacheRoot);
		const scopeDir = path.join(cacheRoot, "@oh-my-pi");
		for (const version of ["14.7.7", "14.7.8"]) {
			const srcDir = path.join(scopeDir, `pi-tui@${version}@@@1`, "src");
			await fs.mkdir(srcDir, { recursive: true });
			await fs.writeFile(path.join(srcDir, "index.ts"), "export {};\n");
		}

		const specifiers = runtimeTuiSpecifiers("omp/14.7.7", cacheRoot);

		expect(specifiers[2]).toContain("pi-tui@14.7.7@@@1");
		expect(specifiers.join("\n").indexOf("pi-tui@14.7.7@@@1")).toBeLessThan(
			specifiers.join("\n").indexOf("pi-tui@14.7.8@@@1"),
		);
	});
});
