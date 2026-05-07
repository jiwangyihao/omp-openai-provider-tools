# OpenAI Provider Tools 插件设计

**日期：** 2026-05-07

## 背景

Oh My Pi (OMP) 是从 Pi / pi-mono 分叉并定制而来的 runtime。两者同源，但不是继承关系：包作用域、配置目录、插件安装机制、TypeScript 加载方式和部分扩展 API 都可能分叉。

本插件面向 Pi-family runtime，目标是在 OMP 与原版 Pi 中为 OpenAI Responses API 的 provider-native tools 提供一致的用户级扩展能力。插件不针对某个中转站，不硬编码 `sub2api`、`baseUrl` 或私有 provider 名。用户可以显式配置 OpenAI 官方 provider，也可以配置实际兼容 OpenAI Responses provider-native tools 的 OpenAI-compatible provider。

## 目标

构建一个名为 `omp-openai-provider-tools` 的独立 npm 包，用于在主模型请求中注入 OpenAI Responses provider-native tools：

- `web_search`
- `image_generation`

插件只负责请求注入、冲突工具移除、image result 保存和可见消息回填。provider tool 的真实执行发生在模型 provider 侧，因此它能共享主请求上下文，包括当前对话文本和已进入主请求的图片输入。

## 非目标

- 不改 OMP 或 Pi 安装缓存。
- 不 fork OMP 或 Pi。
- 不向 OMP 或 Pi 提 PR。
- 不内置任何具体 OpenAI-compatible provider 的名称、域名或凭据。
- 不引入额外搜索或生图服务。
- 不把 image base64 写入后续文本上下文。

## Runtime 支持边界

### OMP

OMP 是首要验证目标。插件通过 `package.json` 的 `omp.extensions` 暴露 extension entry：

```json
{
  "omp": {
    "extensions": ["./src/extension.ts"]
  }
}
```

安装方式：

```bash
omp plugin install omp-openai-provider-tools
```

也支持本地开发链接：

```bash
omp plugin link /path/to/omp-openai-provider-tools
```

OMP 配置读取顺序：

```text
.omp/openai-provider-tools.yml
~/.omp/agent/openai-provider-tools.yml
```

### 原版 Pi

Pi 是正式兼容目标，但兼容性以当前 Pi extension API 和 OpenAI Responses history payload 行为为准。插件通过 `package.json` 的 `pi.extensions` 暴露同一 entry：

```json
{
  "pi": {
    "extensions": ["./src/extension.ts"]
  }
}
```

安装方式：

```bash
pi install npm:omp-openai-provider-tools
pi -e npm:omp-openai-provider-tools
```

Pi 配置读取顺序：

```text
.pi/openai-provider-tools.yml
~/.pi/agent/openai-provider-tools.yml
```

Pi 包发现需要在 `package.json` 中加入：

```json
{
  "keywords": ["pi-package"]
}
```

## 配置模型

插件默认不对任何 provider 注入 tools。用户必须显式配置匹配规则。

示例：

```yaml
providers:
  - name: official-openai
    match:
      api: openai-responses
      provider: openai
    tools:
      web_search:
        enabled: true
        search_context_size: high
      image_generation:
        enabled: true
        output_format: png

  - name: private-openai-compatible-gateway
    match:
      api: openai-responses
      provider: my-openai-compatible-provider
    tools:
      web_search:
        enabled: true
      image_generation:
        enabled: true
        output_format: png
```

匹配字段：

- `api`：必填，必须为 `openai-responses`。
- `provider`：可选，匹配 runtime model provider 名。
- `baseUrl`：可选，支持完全匹配或包含匹配。
- `modelId`：可选，匹配 runtime model id。
- `modelName`：可选，匹配 runtime model name。

规则：

- 第一条匹配配置生效，不做多配置合并。
- 没有匹配配置时，不注入 provider tools，也不改变 active tools。
- 配置文件缺失时静默跳过，并记录 debug。
- 配置文件存在但结构无效时记录 warning，并跳过该配置。

## 请求注入

插件监听 `before_provider_request`。当前模型匹配配置时，插件同步原地修改 payload：

- 确保 `payload.tools` 是数组。
- 追加配置启用的 provider-native tools。
- 不覆盖已有 tools。
- 不重复追加同类型 provider tool。
- 不设置 `tool_choice`。

`web_search` 注入示例：

```json
{
  "type": "web_search",
  "search_context_size": "high"
}
```

`image_generation` 注入示例：

```json
{
  "type": "image_generation",
  "output_format": "png"
}
```

可选 image 参数：

- `output_format`
- `quality`
- `size`
- `background`
- `action`

默认不设置 `action`，由 provider 根据主请求上下文决定生成或编辑。

## 本地工具冲突处理

当当前模型匹配配置后，插件在 `session_start` 和 `before_agent_start` 检查 active tools，并移除会与 provider-native 能力混淆的 host-side tools：

- `web_search`
- `generate_image`

目的：模型上下文中只出现一种搜索/生图语义，即 provider-native tools。未匹配配置的模型不改变 active tools。

如果移除 active tools 后 runtime 重建了 system prompt，插件在 `before_agent_start` 返回最新 system prompt，避免本轮请求仍携带旧工具描述。

## Image result 处理

provider-native `image_generation` 不会表现为 runtime 本地 tool result。插件在 `agent_end` 后读取 assistant message 的 provider history：

```ts
assistant.providerPayload.items[]
```

查找：

```ts
item.type === "image_generation_call"
typeof item.result === "string"
```

处理流程：

1. 去除可选 data URI 前缀。
2. base64 解码为图片 bytes。
3. 根据 `output_format` 或 MIME type 判断扩展名。
4. 使用图片 bytes 的 SHA-256 前缀生成稳定文件名。
5. 保存到 session artifact 目录；没有 artifact 目录时保存到项目本地目录：
   - OMP：`.omp/provider-tool-images/`
   - Pi：`.pi/provider-tool-images/`
6. 发送可见 custom message，内容包含：
   - 图片路径
   - MIME type
   - bytes
   - size / quality / output_format
   - revised prompt

custom message 不包含 base64。保存图片只服务于用户访问和审计，不替代 provider-native history。

## 错误处理

- 配置缺失：记录 debug，不影响会话。
- 配置语法或结构错误：记录 warning，不注入 tools。
- 当前 runtime 缺少必要事件或 payload 行为：记录 warning，说明当前 runtime/version 不满足插件要求。
- provider 拒绝某个 tool：保留 provider/runtime 原始错误语义。
- image result 解析失败：记录 warning，并发送可见消息说明图片结果未保存。
- image result 保存失败：记录 warning，并发送可见消息说明保存失败的真实原因。

## 包依赖策略

OMP 与 Pi 使用不同 package scope：

- OMP：`@oh-my-pi/*`
- Pi：`@mariozechner/*`

插件运行时不能强绑定其中一个 scope。实现要求：

- extension factory 只依赖 runtime 传入的 `pi` 对象。
- 内部定义最小 TypeScript shape，避免运行时 import OMP/Pi core 包。
- 测试使用 fake `ExtensionAPI` 和 fake event context。
- 若需要类型增强，只使用 `import type`，并确保不会生成运行时依赖。
- YAML 解析器作为普通 runtime dependency 打包，由 npm / Pi package install 安装。

## 测试策略

### 单元测试

覆盖：

- 配置解析。
- OMP 配置路径解析。
- Pi 配置路径解析。
- 官方 OpenAI provider 匹配。
- OpenAI-compatible provider 匹配。
- 第一条匹配规则生效。
- 不匹配模型时不注入、不移除 tools。
- `web_search` 注入不重复。
- `image_generation` 注入不重复。
- 不设置 `tool_choice`。
- host-side tools 移除逻辑。
- `image_generation_call.result` 提取。
- data URI 前缀处理。
- 图片保存路径和去重。
- custom message 构造。
- 错误消息不伪装成功。

### Extension 事件测试

使用 fake API 覆盖：

- `session_start`
- `before_agent_start`
- `before_provider_request`
- `agent_end`

### Runtime 兼容验证

手动验证矩阵：

| Runtime | 安装方式 | 验证内容 |
| --- | --- | --- |
| OMP | `omp plugin link` | extension 加载、工具注入、图片保存 |
| OMP | `omp plugin install` | npm 包安装路径、manifest 加载 |
| Pi | `pi -e` | 临时加载、事件兼容 |
| Pi | `pi install` | package install、配置路径、manifest 加载 |

真实 provider e2e 不进入默认测试，避免消耗用户额度。README 提供手动验证命令和预期事件形状。

## 文档要求

README 必须包含：

- 项目定位：OpenAI Responses provider-native tools package for Pi-family runtimes。
- OMP 安装方式。
- Pi 安装方式。
- 官方 OpenAI 配置示例。
- OpenAI-compatible provider 配置示例。
- 配置路径说明。
- 支持的 tool 参数。
- Runtime 兼容要求。
- 手动验证步骤。
- 常见错误排查。

## 成功标准

- 用户可以不改 OMP/Pi 源码，通过安装插件启用 provider-native `web_search`。
- 用户可以配置官方 OpenAI provider 或 OpenAI-compatible provider。
- 模型上下文中不会同时暴露 host-side 搜索/生图工具和 provider-native tools。
- provider 返回 `image_generation_call.result` 时，插件能保存图片并回填可见消息。
- provider 或 runtime 不兼容时，用户能看到真实错误或 warning。
- npm 包同时提供 `omp.extensions` 与 `pi.extensions` entry。
- OMP 与 Pi 的兼容差异在 README 中明确说明。
