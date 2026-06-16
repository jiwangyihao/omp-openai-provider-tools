# v0.1.9

`omp-openai-provider-tools` 的 OMP 恢复会话 provider result replay 修复版本。

## 变更

- 修复恢复包含 provider-native `web_search` 结果的会话后，已显示的 `openai-provider-tool-result` 消息重新进入 session branch 时，同一个已持久化 provider result card 被重复重放的问题。
- provider result replay 现在会识别当前分支上已经存在的本插件 UI-only display message，并把对应 `resultKey` 标记为已显示，避免后续 `session_tree` 更新再次发送同一张卡片。
- 保留跨分支切换时对真正新增持久化 provider result entry 的重放能力；只抑制由自身 display message 引起的重复 replay。

## 安装与升级

OMP 用户请使用带明确版本号的命令安装或升级：

```bash
omp plugin install npm:omp-openai-provider-tools@0.1.9
```

安装或升级后建议运行：

```bash
omp plugin doctor
```

如果 OMP 已在运行，升级后请重启会话再验证恢复会话与 provider-native result card 行为。

## 验证

发布前需通过：

```bash
bun test
npm pack --dry-run --json
omp --no-title --print ping
omp --extension C:/Users/34404/.omp/plugins/node_modules/omp-openai-provider-tools/src/extension.ts --no-title --print ping
omp plugin doctor
```

额外回归验证：恢复含 `openai-provider-tool-result-ui` 持久化条目的会话后，已存在的 display message 不应触发同一 `resultKey` 再次 replay。

## 发布信息

- Package: `omp-openai-provider-tools`
- Version: `0.1.9`
- Repository: <https://github.com/jiwangyihao/omp-openai-provider-tools>
