# Provider Tools 模型配置迁移实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:test-driven-development 执行每个行为变更；完成后使用 superpowers:verification-before-completion 和 superpowers:requesting-code-review。步骤使用复选框语法跟踪进度。

**目标：** 移除独立 `openai-provider-tools.yml` 作为主配置面的必要性，改由 OMP `models.yml` 中的 provider/model `compat.openaiProviderTools` 控制 provider-native OpenAI Responses tools。

**架构：** 插件在 request lifecycle 中直接从 runtime model 元数据推导 provider tool entry。官方 OpenAI Responses provider 默认启用 `web_search` provider-native 注入；自定义 provider 需要 provider/model merge 后的 `compat.openaiProviderTools.enabled: true`；`image_generation` 始终需要模型级 `compat.openaiProviderTools.imageGeneration: true`。旧独立 YAML 配置保留为 legacy fallback 以避免破坏现有项目。

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
  - legacy `openai-provider-tools.yml` 只作为 fallback 或显式 override 保留。
- 修改：`test/extension.test.ts`
  - 添加红灯测试覆盖官方默认启用、自定义 provider opt-in、未 opt-in 不启用、模型级图片 opt-in、新 `compat` 路径优先于 legacy `extraBody`。
- 修改：`README.md`、`docs/runtime-compatibility.md`
  - 文档改为推荐 `models.yml` provider/model `compat.openaiProviderTools`，将独立 YAML 和 `compat.extraBody` 标注为 legacy。
- 修改：`C:/Users/34404/.omp/agent/models.yml`
  - 把当前 `sub2api-openai` provider 启用标记移入 provider 级 `compat.openaiProviderTools.enabled: true`。
  - 把 `gpt-5.5-image` 模型图片标记改为 `compat.openaiProviderTools.imageGeneration: true`。
- 可选移除：`omp-provider-tools-live-test/.omp/openai-provider-tools.yml`
  - live-test 项目不再需要独立插件配置；若保留，应只作为 legacy 测试样本。

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
it("injects web_search for official OpenAI Responses without plugin YAML", async () => {
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
bun test test/extension.test.ts --test-name-pattern "official OpenAI Responses without plugin YAML|custom providers without provider opt-in|compat.openaiProviderTools enabled|compat.openaiProviderTools imageGeneration"
```

预期：至少官方默认、自定义 opt-in、图片 opt-in 测试失败，因为当前实现依赖独立 YAML。

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
	web_search?: unknown;
	imageGeneration?: unknown;
	image_generation?: unknown;
	outputDirectory?: unknown;
	output_directory?: unknown;
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
		name: "runtime-model-openai-provider-tools",
		match: { api: "openai-responses" },
		tools: {
			web_search: { enabled: metadata && Object.hasOwn(metadata, "webSearch") ? isEnabledFlag(metadata.webSearch) : metadata && Object.hasOwn(metadata, "web_search") ? isEnabledFlag(metadata.web_search) : true },
			...(imageEnabled ? { image_generation: { enabled: true } } : {}),
		},
		output: typeof metadata?.outputDirectory === "string" ? { directory: metadata.outputDirectory } : typeof metadata?.output_directory === "string" ? { directory: metadata.output_directory } : undefined,
	};
}
```

- [ ] **步骤 3：更新 entry resolution**

在 `before_agent_start` 和 `before_provider_request` 中，先尝试 legacy config match，再使用 model-derived entry；或先使用 model-derived entry，legacy config 仅当存在匹配时覆盖 tool 参数。实现必须确保：

```ts
const entry = findMatchingProvider(config, target) ?? providerEntryFromModel(eligibilityModel);
```

若 legacy config 不存在且官方/provider opt-in 成立，仍能注入。

- [ ] **步骤 4：保留 legacy 路径**

`modelAllowsProviderImageGeneration()` 继续支持旧 `compat.extraBody.openai_provider_tools.image_generation`，但新增优先读取 `compat.openaiProviderTools.imageGeneration` 和 `compat.openaiProviderTools.image_generation`。

- [ ] **步骤 5：运行绿灯测试**

运行同任务 1 focused 命令，预期全部通过。

---

### 任务 3：更新配置与文档

**文件：**
- 修改：`README.md`
- 修改：`docs/runtime-compatibility.md`
- 修改：`C:/Users/34404/.omp/agent/models.yml`
- 可选修改：`omp-provider-tools-live-test/.omp/openai-provider-tools.yml`

- [ ] **步骤 1：更新 README**

说明：

```md
推荐配置面是 OMP `models.yml`：
- 官方 OpenAI Responses provider 默认启用 provider-native `web_search`。
- 自定义 OpenAI-compatible Responses provider 使用 `compat.openaiProviderTools.enabled: true` 启用。
- 图片模型使用 `compat.openaiProviderTools.imageGeneration: true` 启用 `image_generation`。
- `openai-provider-tools.yml` 是 legacy fallback，不推荐新配置使用。
- `compat.extraBody.openai_provider_tools` 是 legacy marker，不再推荐。
```

- [ ] **步骤 2：更新 runtime docs**

记录源码推断结论：OMP `models.yml` 最终 runtime model 保留 `compat`，但顶层未知字段不会进入 `Model`；插件因此使用 `compat.openaiProviderTools` 而不是 `extraBody`。

- [ ] **步骤 3：迁移用户模型配置**

将 provider `sub2api-openai` 增加：

```yaml
compat:
  openaiProviderTools:
    enabled: true
```

将 `gpt-5.5-image` 模型从：

```yaml
compat:
  extraBody:
    openai_provider_tools:
      image_generation: true
```

改为：

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
bun test test/extension.test.ts --test-name-pattern "official OpenAI Responses without plugin YAML|custom providers without provider opt-in|compat.openaiProviderTools enabled|compat.openaiProviderTools imageGeneration"
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

审查重点：官方默认启用边界、自定义 provider opt-in、图片模型 opt-in、legacy fallback 不破坏、无 `tool_choice`、不把插件 metadata 发送给 provider。

- [ ] **步骤 6：提交**

提交仓库文件，不提交用户级 `models.yml`：

```bash
git add src/extension.ts src/types.ts test/extension.test.ts README.md docs/runtime-compatibility.md docs/superpowers/plans/2026-05-08-provider-tools-model-config-migration.md
git commit -m "feat(扩展): 改用模型配置启用 provider tools"
```
