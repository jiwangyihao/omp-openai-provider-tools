#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";


const DEFAULT_AGENT_NAME = "image_generator";
const DEFAULT_THINKING_LEVEL = "xhigh";

const ALLOWED_THINKING_LEVELS = new Set(["low", "medium", "high", "xhigh"]);
const SAFE_AGENT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/u;
function usage() {
	return [
		"Usage:",
		"  omp-openai-provider-tools configure-image-agent --model <image-capable-model> [options]",
		"",
		"Options:",
		"  --model <model>          Required. Actual image-capable model alias from the user's provider config.",
		"  --agent <name>           Agent name. Default: image_generator",
		"  --thinking <level>       Agent thinking level. Default: xhigh",
		"  --agent-dir <path>       Override agent directory for tests or custom layouts.",
		"  --runtime <omp|pi>       Choose default agent directory. Default: omp",
		"  --print                  Print the template without writing files.",
		"  --dry-run                Print target path and template without writing files.",
		"  --force                  Overwrite an existing agent file.",
		"  --help                   Show this help.",
		"",
		"Example:",
		"  npx omp-openai-provider-tools configure-image-agent --model <image-capable-model-alias>",
	].join("\n");
}

function quoteYamlString(value) {
	return JSON.stringify(value);
}

function normalizeAgentFileName(agentName) {
	return `${agentName.trim().replace(/_/g, "-")}.md`;
}

function defaultAgentDir(runtime) {
	if (runtime === "pi") return join(homedir(), ".pi", "agent", "agents");
	return join(homedir(), ".omp", "agent", "agents");
}

export function renderImageAgentTemplate(options) {
	const agentName = options.agentName.trim() || DEFAULT_AGENT_NAME;
	const model = options.model.trim();
	const thinkingLevel = options.thinkingLevel.trim() || DEFAULT_THINKING_LEVEL;

	return `---
name: ${agentName}
description: 专门生成、迭代和校验图像的子代理。用户要求画图、生成图片、修改图片、制作视觉素材，且不需要改代码时使用。
model: ${quoteYamlString(model)}
tools:
  - read
  - find
  - search
  - yield
thinkingLevel: ${thinkingLevel}
---

你是专门的图像生成子代理。你的职责不是被动改写一句提示词，而是把主 Agent 交给你的视觉目标转化为高质量、可验证、可迭代的 provider-native \`image_generation\` 生成流程。

边界：
1. 只处理图像生成、图像编辑、视觉提示词细化、构图、风格、品牌视觉、产品图、插画和素材制作相关任务。
2. 不修改代码、不提交、不写项目文件、不运行构建或测试命令；除非用户明确要求，否则只读项目上下文。
3. 不调用主机侧 \`generate_image\`；当前模型必须通过 provider-native \`image_generation\` 生成或编辑图像。
4. 不编造保存路径、URL、文件名、生成状态或工具结果。

主动收集上下文：
1. 先从主 Agent 的 assignment 中提取用户真实目标、硬性约束、参考图、上一轮 provider 生成图、尺寸、风格、用途和验收标准。
2. 如果任务涉及当前项目的 UI、品牌、产品、页面、素材或文档，使用可用的只读工具自行收集上下文：优先用 \`find\` 定位 README、设计文档、assets、screenshots、public/static、docs、brand/style 说明；用 \`search\` 查找品牌名、配色、logo、screenshot、image、design、style 等相关线索；用 \`read\` 读取必要文件片段。
3. 只读取与视觉任务直接相关的少量文件；不要全仓漫游，不要读取密钥、私有模型配置或无关日志。
4. 如果缺少会显著改变结果的关键选择，最多问一个最小澄清问题；否则基于已收集上下文和合理默认继续。

生成策略：
1. 生成前整理：主体、环境、风格、构图、镜头/视角、光线、色彩、材质、细节、负面约束、输出比例。
2. 保留用户硬性要求，不把主题替换成相近但不同的对象。
3. 避免加入用户没要求的文字、水印、Logo、签名、复杂背景、额外人物或额外动物。
4. 用户使用中文时，优先用中文组织提示词；必要的风格词可以保留英文。
5. 如果上下文里有上一张 provider 生成图或用户提供的参考图，必须先比较参考图和本轮修改要求，再决定如何编辑或重绘；不要无视参考图另起炉灶。

生成后校验与迭代：
1. 图像生成完成后，对照用户要求逐项自检：主体是否正确、机器人/机械属性是否体现、构图和比例是否符合、背景是否过度复杂、是否出现文字/水印/Logo、是否满足参考图和上下文约束。
2. 如果结果明显不满足硬性要求，最多主动再生成一次，并在第二次提示词中明确修正失败点。
3. 最多主动重试一次；第二次仍有偏差时，如实报告偏差和建议，不继续消耗额度。
4. 如果结果满足要求，不要为了微小主观优化反复生成。

最终回复：
1. 必须通过 \`yield\` 返回。
2. 输出保持简短，包含：生成状态、最终提示词摘要、保存路径或 artifact（如果可见）、自检结论、后续可迭代方向。
3. 如果看到了运行时插件回显的保存路径，必须原样写出；如果没有看到，不要编造路径，说明「图像已请求生成，请查看 provider 图片保存回显消息中的 Path」。
4. 不要在最终回复中包含 base64 或长篇内部分析，除非用户明确要求。
`;
}

function parseConfigureOptions(args) {
	let model = "";
	let agentName = DEFAULT_AGENT_NAME;
	let thinkingLevel = DEFAULT_THINKING_LEVEL;
	let runtime = "omp";
	let agentDir = "";
	let force = false;
	let print = false;
	let dryRun = false;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		const next = () => {
			const value = args[index + 1];
			if (!value || value.startsWith("--")) return undefined;
			index += 1;
			return value;
		};

		if (arg === "--help" || arg === "-h") return { help: true };
		if (arg === "--model") {
			model = next() ?? "";
			continue;
		}
		if (arg === "--agent") {
			agentName = next() ?? "";
			continue;
		}
		if (arg === "--thinking") {
			thinkingLevel = next() ?? "";
			continue;
		}
		if (arg === "--runtime") {
			runtime = next() ?? "";
			continue;
		}
		if (arg === "--agent-dir") {
			agentDir = next() ?? "";
			continue;
		}
		if (arg === "--force") {
			force = true;
			continue;
		}
		if (arg === "--print") {
			print = true;
			continue;
		}
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		return { error: `Unknown argument: ${arg}` };
	}

	if (!model.trim()) return { error: "Missing required --model <image-capable-model>. Let the installing Agent fill this from the user's actual provider/model config." };
	if (!agentName.trim()) return { error: "--agent must not be empty." };
	if (!SAFE_AGENT_NAME_PATTERN.test(agentName.trim())) return { error: "--agent may only contain letters, numbers, underscores, and hyphens." };
	if (!thinkingLevel.trim()) return { error: "--thinking must not be empty." };
	if (!ALLOWED_THINKING_LEVELS.has(thinkingLevel.trim())) return { error: "--thinking must be one of: low, medium, high, xhigh." };
	if (runtime !== "omp" && runtime !== "pi") return { error: "--runtime must be either omp or pi." };

	return {
		model,
		agentName,
		thinkingLevel,
		runtime,
		agentDir: agentDir || defaultAgentDir(runtime),
		force,
		print,
		dryRun,
	};
}

async function configureImageAgent(args, io) {
	const parsed = parseConfigureOptions(args);
	if ("help" in parsed) {
		io.stdout.write(`${usage()}\n`);
		return 0;
	}
	if ("error" in parsed) {
		io.stderr.write(`${parsed.error}\n\n${usage()}\n`);
		return 2;
	}

	const content = renderImageAgentTemplate(parsed);
	const targetPath = join(parsed.agentDir, normalizeAgentFileName(parsed.agentName));

	if (parsed.print) {
		io.stdout.write(content);
		return 0;
	}

	if (parsed.dryRun) {
		io.stdout.write(`Would write ${targetPath}\n\n${content}`);
		return 0;
	}

	if (existsSync(targetPath) && !parsed.force) {
		io.stderr.write(`Agent file already exists: ${targetPath}\nUse --force to overwrite, or --print to generate a template for manual merge.\n`);
		return 2;
	}

	await mkdir(parsed.agentDir, { recursive: true });
	await writeFile(targetPath, content, "utf8");
	io.stdout.write(`Wrote ${targetPath}\n`);
	return 0;
}

function isMainModule() {
	return process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
}

export async function runCli(argv = process.argv.slice(2), io = process) {
	const [command, ...args] = argv;
	if (!command || command === "--help" || command === "-h") {
		io.stdout.write(`${usage()}\n`);
		return 0;
	}
	if (command === "configure-image-agent") {
		return configureImageAgent(args, io);
	}
	io.stderr.write(`Unknown command: ${command}\n\n${usage()}\n`);
	return 2;
}

if (isMainModule()) {
	const exitCode = await runCli();
	process.exit(exitCode);
}
