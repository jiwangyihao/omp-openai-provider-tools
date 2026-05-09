# v0.1.2

`omp-openai-provider-tools` 的图像子代理配置命令版本。

## 变更

- 新增 `omp-openai-provider-tools configure-image-agent` CLI，用于显式生成推荐的 `image_generator` 子代理模板。
- CLI 要求安装 Agent 通过 `--model` 填写用户实际 provider/model 配置中的图像能力模型别名，不在文档中提供私有路由示例。
- 默认生成 `thinkingLevel: xhigh`，并授予子代理只读上下文工具 `read` / `find` / `search` 和 `yield`。
- 生成的子代理提示词要求主动收集项目视觉上下文、自检生成结果，并在明显不满足硬性要求时最多主动再生成一次。
- 插件安装仍然无副作用：不会在安装时自动写入或覆盖用户 agent 配置；CLI 默认拒绝覆盖，只有显式 `--force` 才会替换已有文件。
- README 补充 `npx omp-openai-provider-tools configure-image-agent --model <image-capable-model-alias>` 使用说明，强调 `--model` 由安装 Agent 根据用户实际配置填写。

## 安装与升级

OMP 用户请使用带明确版本号的命令安装或升级：

```bash
omp plugin install npm:omp-openai-provider-tools@0.1.2
```

安装或升级后建议运行：

```bash
omp plugin doctor
```

## 可选：生成图像子代理模板

先预览将要写入的内容：

```bash
npx omp-openai-provider-tools configure-image-agent --model <image-capable-model-alias> --dry-run
```

确认 `--model` 已替换为用户实际图像能力模型别名后再写入：

```bash
npx omp-openai-provider-tools configure-image-agent --model <image-capable-model-alias>
```

## 验证

发布前应至少通过：

```bash
bun test
npm pack --dry-run --json
bun pm pack --dry-run
omp plugin doctor
```

## 发布信息

- Package: `omp-openai-provider-tools`
- Version: `0.1.2`
- Repository: <https://github.com/jiwangyihao/omp-openai-provider-tools>
