# v0.1.4

`omp-openai-provider-tools` 的 provider-native `web_search` 实时 overlay 修复版本。

## 变更

- 修复 interactive OMP TUI 中实时 `web_search` overlay 因 TUI `requestRender` 方法失绑而报错、关闭并禁用后续 overlay 的问题。
- 修复最终 `web_search` 回显过晚的问题：`message_end` 已拿到完整结果且 runtime 已 idle 时，会立即 flush UI-only final card；runtime 仍在 streaming / non-idle 时继续使用原有 idle-gated retry 路径，避免 `sendMessage` 在 streaming 阶段变成 steer。
- 修复 live overlay 标题 `calls N` 语义：现在表示 overlay 生命周期内累计可展示 call 总数，不会因为 completed 项折叠、隐藏或列表行数限制而下降。
- 调整 completed 项折叠 / 隐藏策略：展示项增长到 3 个后不会再降到 3 以下；非 completed 项保持展开，较旧 completed 优先折叠或隐藏。
- 补充 live overlay 生命周期、计数、折叠和隐藏语义文档。

## 安装与升级

OMP 用户请使用带明确版本号的命令安装或升级：

```bash
omp plugin install npm:omp-openai-provider-tools@0.1.4
```

安装或升级后建议运行：

```bash
omp plugin doctor
```

如果 OMP 已在运行，升级后请重启会话再验证 provider-native `web_search` overlay。

## 验证

发布前已通过：

```bash
bun test --timeout 10000
bun pm pack --dry-run
npm pack --dry-run --json
omp plugin doctor
```

## 发布信息

- Package: `omp-openai-provider-tools`
- Version: `0.1.4`
- Repository: <https://github.com/jiwangyihao/omp-openai-provider-tools>
