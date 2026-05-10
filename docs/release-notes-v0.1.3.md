# v0.1.3

`omp-openai-provider-tools` 的 provider-native `image_generation` 长时间生成修复版本。

## 变更

- 修复 OpenAI Responses provider-native `image_generation` 长时间生成时，provider 只发送传输层心跳但 OMP 14.9+ 语义 idle watchdog 仍可能触发 `OpenAI responses stream stalled while waiting for the next event` 的问题。
- 插件现在为已注入 `image_generation` 的请求插入请求级语义 keepalive，且 keepalive 调度锚定到上一次插件合成 keepalive，不会被 provider 的 SSE comment 或非语义 `keepalive` 事件无限推迟。
- SDK `Stream.fromSSEResponse` 包装层同步支持相同 keepalive 语义；下游取消时会 abort 对应 controller，避免合成 keepalive 赢得竞态后取消路径挂住。
- 上游 stream 读取失败时会清理 keepalive timer，避免错误后遗留定时器继续向已终止 controller 写入。
- 修复扩展加载时对 OpenAI SDK 的静态依赖：改为惰性动态导入，运行时依赖仍只包含 `yaml`。
- 收紧自定义 provider 的 fallback 注入边界：仅设置 `imageGeneration: true` 时只注入 `image_generation`，不会顺带默认注入 `web_search`。
- 补充 README 说明：该 keepalive 只作用于插件注入 `image_generation` 的请求，不会全局关闭 OMP timeout 保护。

## 安装与升级

OMP 用户请使用带明确版本号的命令安装或升级：

```bash
omp plugin install npm:omp-openai-provider-tools@0.1.3
```

安装或升级后建议运行：

```bash
omp plugin doctor
```

如果 OMP 已在运行，升级后请重启会话再验证 provider-native `image_generation`。

## 验证

发布前已通过：

```bash
bun test
npm pack --dry-run --json
omp plugin doctor
```

## 发布信息

- Package: `omp-openai-provider-tools`
- Version: `0.1.3`
- Repository: <https://github.com/jiwangyihao/omp-openai-provider-tools>
