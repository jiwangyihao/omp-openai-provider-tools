# Provider Tools 模型配置迁移实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:test-driven-development 执行每个行为变更；完成后使用 superpowers:verification-before-completion 和 superpowers:requesting-code-review。步骤使用复选框语法跟踪进度。

**目标：** 移除独立 `openai-provider-tools.yml` 作为主配置面的必要性，改由 OMP `models.yml` 中的 provider/model `compat.openaiProviderTools` 控制 provider-native OpenAI Responses tools。

**架构：** 插件在 request lifecycle 中直接从 runtime model 元数据推导 provider tool entry。官方 OpenAI Responses provider 默认启用 `web_search` provider-native 注入；自定义 provider 需要 provider/model merge 后的 `compat.openaiProviderTools.enabled: true`；`image_generation` 始终需要模型级 `compat.openaiProviderTools.imageGeneration: true`。插件不再加载独立 `openai-provider-tools.yml`，也不再识别旧 `compat.extraBody` 标记。

**技术栈：** Bun test、TypeScript、OMP extension hooks、OpenAI Responses payload mutation。

---

## 文件结构

- 修改：`src/types.ts`
  - 扩展 `RuntimeModelLike.compat`，允许 `openaiProviderTools` provider/model 元数据。
- 修改：`src/extension.ts`
  - 新增 model-derived provider tool entry 构造逻辑。
  - 官方 OpenAI Responses 默认启用 `web_search`。
  - 自定义 provider 通过 `compat.openaiProviderTools.enabled` 启用 `web_search`。
  - 图片通过 `compat.openaiProviderTools.imageGeneration` 启用。
  - 移除 legacy `openai-provider-tools.yml` fallback 和旧 metadata marker。
- 修改：`test/extension.test.ts`
  - 添加红灯测试覆盖官方默认启用、自定义 provider opt-in、未 opt-in 不启用、模型级图片 opt-in、旧 `compat.extraBody` 不再启用图片。
- 修改：`README.md`、`docs/runtime-compatibility.md`
  - 文档改为只推荐 `models.yml` provider/model `compat.openaiProviderTools`，移除独立 YAML 和 `compat.extraBody` 兼容说明。
- 修改：`C:/Users/34404/.omp/agent/models.yml`
  - 把当前 `sub2api-openai` provider 启用标记移入 provider 级 `compat.openaiProviderTools.enabled: true`。
  - 把 `gpt-5.5-image` 模型图片标记改为 `compat.openaiProviderTools.imageGeneration: true`。
- 删除：`omp-provider-tools-live-test/.omp/openai-provider-tools.yml`
  - live-test 项目不再保留独立插件配置。

---

### 任务 1：新增模型配置红灯测试

**文件：**
- 修改：`test/extension.test.ts`

- [ ] **步骤 1：添加 fixture**

添加：

```ts
const customProviderModel = {
	...targetModel,
	provider: "custom-openai-compatible",
	baseUrl: "https://gateway.example.invalid/v1",
};

const providerToolsEnabledModel = {
	...customProviderModel,
	compat: {
		openaiProviderTools: {
			enabled: true,
		},
	},
};

const providerToolsImageModel = {
	...providerToolsEnabledModel,
	compat: {
		openaiProviderTools: {
			enabled: true,
			imageGeneration: true,
		},
	},
};
```

- [ ] **步骤 2：添加失败测试**

新增测试：

```ts
it("injects web_search for official OpenAI Responses from model metadata", async () => {
	const cwd = await makeTempDir();
	const homeDir = await makeTempDir();
	const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
	const ctx = context(cwd, homeDir);
	const payload: Record<string, unknown> = { model: "gpt-5", input: "current news" };

	await runSessionStart(extension, ctx);
	await runBeforeProvider(extension, payload, ctx, { requestModel: targetModel });

	expect(payload.tools).toEqual([{ type: "web_search" }]);
	expect(payload).not.toHaveProperty("tool_choice");
});
```

新增测试：

```ts
it("does not inject provider tools for custom providers without provider opt-in", async () => {
	const cwd = await makeTempDir();
	const homeDir = await makeTempDir();
	const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
	const ctx = context(cwd, homeDir, { model: customProviderModel });
	const payload: Record<string, unknown> = { model: "custom-model", input: "current news" };

	await runSessionStart(extension, ctx);
	await runBeforeProvider(extension, payload, ctx, { requestModel: customProviderModel });

	expect(payload.tools).toBeUndefined();
});
```

新增测试：

```ts
it("injects web_search for custom providers with compat.openaiProviderTools enabled", async () => {
	const cwd = await makeTempDir();
	const homeDir = await makeTempDir();
	const extension = registerExtension({ initialActiveTools: ["read", "generate_image"] });
	const ctx = context(cwd, homeDir, { model: providerToolsEnabledModel });
	const payload: Record<string, unknown> = { model: "custom-model", input: "current news" };

	await runSessionStart(extension, ctx);
	await runBeforeProvider(extension, payload, ctx, { requestModel: providerToolsEnabledModel });

	expect(payload.tools).toEqual([{ type: "web_search" }]);
});
```

新增测试：

```ts
it("injects image_generation only when compat.openaiProviderTools imageGeneration is enabled", async () => {
	const cwd = await makeTempDir();
	const homeDir = await makeTempDir();
	const extension = registerExtension({ initialActiveTools: ["read"] });
	const ctx = context(cwd, homeDir, { model: providerToolsImageModel });
	const payload: Record<string, unknown> = { model: "custom-image-model", input: "create image" };

	await runSessionStart(extension, ctx);
	await runBeforeProvider(extension, payload, ctx, { requestModel: providerToolsImageModel });

	expect(payload.tools).toEqual([{ type: "web_search" }, { type: "image_generation" }]);
});
```

- [ ] **步骤 3：运行红灯测试**

运行：

```bash
bun test test/extension.test.ts --test-name-pattern "official OpenAI Responses from model metadata|custom providers without provider opt-in|compat.openaiProviderTools enabled|compat.openaiProviderTools imageGeneration|extraBody image markers"
```

预期：至少官方默认、自定义 opt-in、图片 opt-in 或旧 extraBody 禁用测试失败，因为当前实现仍依赖旧兼容路径。

---

### 任务 2：实现模型配置推导

**文件：**
- 修改：`src/types.ts`
- 修改：`src/extension.ts`

- [ ] **步骤 1：扩展类型**

在 `RuntimeModelLike.compat` 中加入：

```ts
openaiProviderTools?: {
	enabled?: unknown;
	webSearch?: unknown;
	imageGeneration?: unknown;
	outputDirectory?: unknown;
};
```

- [ ] **步骤 2：新增 helper**

在 `src/extension.ts` 添加：

```ts
function openAIProviderToolsMetadata(model: RuntimeModelLike | undefined): Record<string, unknown> | undefined {
	const compatMetadata = model?.compat?.openaiProviderTools;
	if (isRecord(compatMetadata)) return compatMetadata;
	return undefined;
}
```

添加官方 provider 判定：

```ts
function isOfficialOpenAIResponsesProvider(model: RuntimeModelLike | undefined): boolean {
	if (!isExplicitOpenAIResponsesModel(model)) return false;
	const provider = typeof model?.provider === "string" ? model.provider.trim().toLowerCase() : "";
	if (provider === "openai") return true;
	let host = "";
	try {
		host = model?.baseUrl ? new URL(model.baseUrl).host.toLowerCase() : "";
	} catch {
		return false;
	}
	return host === "api.openai.com";
}
```

添加 model-derived entry 构造：

```ts
function providerEntryFromModel(model: RuntimeModelLike | undefined): ProviderToolsEntry | undefined {
	if (!isExplicitOpenAIResponsesModel(model)) return undefined;
	const metadata = openAIProviderToolsMetadata(model);
	const providerEnabled = isOfficialOpenAIResponsesProvider(model) || isEnabledFlag(metadata?.enabled);
	if (!providerEnabled) return undefined;
	const imageEnabled = modelAllowsProviderImageGeneration(model);
	return {
		tools: {
			web_search: { enabled: metadata?.webSearch !== false },
			...(imageEnabled ? { image_generation: { enabled: true } } : {}),
		},
		output: typeof metadata?.outputDirectory === "string" ? { directory: metadata.outputDirectory } : undefined,
	};
}
```

- [ ] **步骤 3：更新 entry resolution 并删除 legacy 路径**

在 `before_agent_start` 和 `before_provider_request` 中，只使用 `providerEntryFromModel(...)` 解析 provider tools。删除独立 YAML config loader、`findMatchingProvider(...)` fallback，以及 `modelAllowsProviderImageGeneration()` 中的 `compat.extraBody`、headers、capabilities 等旧 marker。

- [ ] **步骤 4：运行绿灯测试**

运行同任务 1 focused 命令，预期全部通过。

---

### 任务 3：更新配置与文档

**文件：**
- 修改：`README.md`
- 修改：`docs/runtime-compatibility.md`
- 修改：`C:/Users/34404/.omp/agent/models.yml`
- 删除：`omp-provider-tools-live-test/.omp/openai-provider-tools.yml`

- [ ] **步骤 1：更新 README**

说明：

```md
推荐配置面是 OMP `models.yml`：
- 官方 OpenAI Responses provider 默认启用 provider-native `web_search`。
- 自定义 OpenAI-compatible Responses provider 使用 `compat.openaiProviderTools.enabled: true` 启用。
- 图片模型使用 `compat.openaiProviderTools.imageGeneration: true` 启用 `image_generation`。
- 不再支持 `openai-provider-tools.yml` 或 `compat.extraBody.openai_provider_tools`；所有 provider-tool capability marker 都在 `models.yml` 的 `compat.openaiProviderTools` 中维护。
```

- [ ] **步骤 2：更新 runtime docs**

记录源码推断结论：OMP `models.yml` 最终 runtime model 保留 `compat`，但顶层未知字段不会进入 `Model`；插件因此只使用 `compat.openaiProviderTools`，不使用 `extraBody`。

- [ ] **步骤 3：迁移用户模型配置**

将 provider `sub2api-openai` 增加：

```yaml
compat:
  openaiProviderTools:
    enabled: true
```

确认 `gpt-5.5-image` 模型使用：

```yaml
compat:
  openaiProviderTools:
    imageGeneration: true
```

- [ ] **步骤 4：运行配置发现验证**

运行：

```bash
omp --list-models gpt-5.5-image
```

预期仍显示 `gpt-5.5-image-fast`，且 images 为 yes。

---

### 任务 4：验证、审查和提交

**文件：**
- 修改：仓库相关变更

- [ ] **步骤 1：运行 focused tests**

运行：

```bash
bun test test/extension.test.ts --test-name-pattern "official OpenAI Responses from model metadata|custom providers without provider opt-in|compat.openaiProviderTools enabled|compat.openaiProviderTools imageGeneration|extraBody image markers"
```

预期：全部 pass。

- [ ] **步骤 2：运行全量测试**

运行：

```bash
bun test
```

预期：0 fail。

- [ ] **步骤 3：打包 dry-run**

运行：

```bash
bun pm pack --dry-run
```

预期：成功，包含所有 source 文件。

- [ ] **步骤 4：检查包残留**

使用 Find 工具检查 `omp-openai-provider-tools/*.tgz`，预期无结果。

- [ ] **步骤 5：请求代码审查**

审查范围：

```text
src/extension.ts
src/types.ts
test/extension.test.ts
README.md
docs/runtime-compatibility.md
C:/Users/34404/.omp/agent/models.yml
```

审查重点：官方默认启用边界、自定义 provider opt-in、图片模型 opt-in、legacy fallback 已删除、无 `tool_choice`、不把插件 metadata 发送给 provider。

- [ ] **步骤 6：提交**

提交仓库文件，不提交用户级 `models.yml`：

```bash
git add src/extension.ts src/types.ts src/match.ts src/provider-tools.ts test/extension.test.ts test/match.test.ts test/request-injection.test.ts README.md docs/runtime-compatibility.md docs/superpowers/plans/2026-05-08-provider-tools-model-config-migration.md
git commit -m "refactor(扩展): 移除 legacy provider tools 配置"
```
