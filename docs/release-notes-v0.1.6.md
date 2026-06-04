# v0.1.6

`omp-openai-provider-tools` 的 provider-native `web_search` live overlay 生命周期修复版本。

## 变更

- 修复多个 provider request / tracker 并发时可能打开多个 `web_search` live overlay 的问题：插件现在复用单一 live panel，并把新的 provider `web_search` 事件追加到当前 panel。
- 调整 live overlay 生命周期：`response.completed`、request-local stream cleanup 和 completed 条目 hide timer 不再关闭 overlay；overlay 只在 final custom message/card 开始显示后、用户按 `q`、session lifecycle cleanup、runtime dispose 或 UI failure 时关闭。
- 移除 Escape 关闭语义：overlay 提示改为 `q close`，并且 `escape`、`esc` 与 raw ESC 输入都不会关闭 panel。
- 保留已有 UI-only 边界：live overlay 不写入 session message，不进入 Agent 上下文；provider-native `web_search` 最终回显仍通过 UI-only final card 路径展示。
- 更新 README 与 runtime compatibility 文档，说明单 overlay、追加事件、关闭时机和完成条目的 collapse/hide 行为。

## 安装与升级

OMP 用户请使用带明确版本号的命令安装或升级：

```bash
omp plugin install npm:omp-openai-provider-tools@0.1.6
```

安装或升级后建议运行：

```bash
omp plugin doctor
```

如果 OMP 已在运行，升级后请重启会话再验证 provider-native `web_search` live overlay 行为。

## 验证

发布前需通过：

```bash
bun test --timeout 10000
bun pm pack --dry-run
npm pack --dry-run --json
git diff --check
omp plugin doctor
```

## 发布信息

- Package: `omp-openai-provider-tools`
- Version: `0.1.6`
- Repository: <https://github.com/jiwangyihao/omp-openai-provider-tools>
