# v0.1.1

`omp-openai-provider-tools` 的文档与许可证更新版本。

## 变更

- 将项目许可证从 MIT 切换为 MPL-2.0。
- 新增 `LICENSE`，包含 Mozilla Public License Version 2.0 全文。
- 重写 README，使其围绕“为 OMP 增加 OpenAI 风格的 provider-executed tool 支持”展开，并补充中英文安装、配置、使用和故障排查说明。
- 在 package manifest 测试中固定许可证元数据、README 许可证链接和 LICENSE 文件存在性，避免后续发布元数据回退。

## 安装与升级

OMP 用户请使用带明确版本号的命令安装或升级：

```bash
omp plugin install npm:omp-openai-provider-tools@0.1.1
```

安装或升级后建议运行：

```bash
omp plugin doctor
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
- Version: `0.1.1`
- Repository: <https://github.com/jiwangyihao/omp-openai-provider-tools>
