# v0.1.7

`omp-openai-provider-tools` 的 OMP 15.13.x provider result renderer 兼容修复版本。

## 变更

- 修复在 OMP 15.13.x 中注册 provider tool result renderer 后，后台预加载 TUI runtime 可能触发 `RangeError: Maximum call stack size exceeded` 的问题。
- provider tool result renderer 现在优先使用 OMP 运行时传入的 `runtimeTuiOverride`；没有 runtime override 且本地 TUI 尚未加载时，才在首次渲染后惰性启动后台加载。
- 保留 renderer 注册与已有 UI 行为：加载完成前返回 `undefined`，由 OMP 默认路径处理；加载完成后继续渲染 provider-native tool result card。

## 安装与升级

OMP 用户请使用带明确版本号的命令安装或升级：

```bash
omp plugin install npm:omp-openai-provider-tools@0.1.7
```

安装或升级后建议运行：

```bash
omp plugin doctor
```

如果 OMP 已在运行，升级后请重启会话再验证 provider-native tool result card 行为。

## 验证

发布前需通过：

```bash
bun test
npm pack --dry-run --json
omp --no-title --print ping
omp --extension C:/Users/34404/.omp/plugins/node_modules/omp-openai-provider-tools/src/extension.ts --no-title --print ping
omp plugin doctor
```

## 发布信息

- Package: `omp-openai-provider-tools`
- Version: `0.1.7`
- Repository: <https://github.com/jiwangyihao/omp-openai-provider-tools>
