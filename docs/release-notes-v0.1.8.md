# v0.1.8

`omp-openai-provider-tools` 的 OMP workspace cwd 栈溢出修复版本。

## 变更

- 修复在 `oh-my-pi` checkout 等 workspace cwd 下运行全局 `omp` 时，provider image renderer 注册阶段后台预加载 TUI runtime 可能触发 `RangeError: Maximum call stack size exceeded` 的问题。
- provider image renderer 现在与 provider tool result renderer 一样保留 renderer 注册，但只在第一次需要渲染且本地 TUI 尚未加载时惰性启动 fallback TUI 加载。
- 避免启动/扩展加载阶段通过当前 cwd 的 bare `@oh-my-pi/pi-tui` resolution 拉入 workspace checkout runtime；优先让 OMP runtime 的渲染路径提供组件，fallback 加载延后到实际渲染需求。

## 安装与升级

OMP 用户请使用带明确版本号的命令安装或升级：

```bash
omp plugin install npm:omp-openai-provider-tools@0.1.8
```

安装或升级后建议运行：

```bash
omp plugin doctor
```

如果 OMP 已在运行，升级后请重启会话再验证 provider-native image/result card 行为。

## 验证

发布前需通过：

```bash
bun test
npm pack --dry-run --json
omp --no-title --print ping
omp --extension C:/Users/34404/.omp/plugins/node_modules/omp-openai-provider-tools/src/extension.ts --no-title --print ping
omp plugin doctor
```

额外复现验证：在 `C:/Users/34404/source/repos/oh-my-pi` cwd 下运行 `omp --no-title --print ping` 必须返回 `pong`。

## 发布信息

- Package: `omp-openai-provider-tools`
- Version: `0.1.8`
- Repository: <https://github.com/jiwangyihao/omp-openai-provider-tools>
