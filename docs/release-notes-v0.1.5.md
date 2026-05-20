# v0.1.5

`omp-openai-provider-tools` 的 provider-native OpenAI Responses tool 元数据兜底修复版本。

## 变更

- 修复部分 OMP 15 路径在 extension hook 上下文中剥离 `compat.openaiProviderTools` 后，插件无法为实际 provider 请求注入 provider-native `web_search` / `image_generation` 的问题。
- 新增插件侧 `models.yml` 元数据兜底：当 hook 模型缺少 `compat.openaiProviderTools` 时，插件会同步读取当前 runtime home 下的 `models.yml`，只合并当前 provider/model 对应的 `openaiProviderTools` 元数据。
- 修复多个 provider 共用同一 gateway `baseUrl` 时的匹配风险：优先按 provider identity 精确匹配，只有没有精确匹配时才使用 `baseUrl` 兜底，避免图像模型误用普通 provider 配置。
- 保持凭据边界不变：插件不会读取、复制、记录或管理 API key；provider 凭据仍由 OMP/Pi 原有模型配置管理。
- 补充 README 与 runtime compatibility 文档，说明 metadata fallback 与 credential boundary。

## 安装与升级

OMP 用户请使用带明确版本号的命令安装或升级：

```bash
omp plugin install npm:omp-openai-provider-tools@0.1.5
```

安装或升级后建议运行：

```bash
omp plugin doctor
```

如果 OMP 已在运行，升级后请重启会话再验证 provider-native `web_search` / `image_generation` 注入。

## 验证

发布前已通过：

```bash
bun test --timeout 10000
bun pm pack --dry-run
npm pack --dry-run --json
git diff --check
omp plugin doctor
```

## 发布信息

- Package: `omp-openai-provider-tools`
- Version: `0.1.5`
- Repository: <https://github.com/jiwangyihao/omp-openai-provider-tools>
