# Web Search Live Overlay 计数与折叠规格

**日期：** 2026-05-13  
**适用仓库：** `C:/tmp/omp-openai-provider-tools`  
**状态：** 待实现

## 1. 背景

`omp-openai-provider-tools` 的 provider-native `web_search` live overlay 会在 OpenAI Responses 流式事件到达时显示实时搜索状态。当前 overlay 已支持：

- `response.web_search_call.*` 生命周期事件；
- `response.output_item.added` / `response.output_item.done`；
- completed 项的折叠 / 隐藏；
- 最终回显成功插入后关闭 live overlay。

用户在真实 OMP TUI 中观察到两个展示问题：

1. overlay 中 completed 项折叠或隐藏后，标题栏 `calls N` 似乎也随之减少。用户期望标题栏表示本次 overlay 打开期间累计出现过的调用总数，而不是当前可见列表项数量。
2. 当 overlay 内项目数量不超过 3 个时，completed 项不应该折叠；只有项目大于 3 个时才需要折叠 completed 项，以节省空间。

本规格只处理 live overlay 的计数和折叠策略，不处理最终 `web_search` 回显路径。

## 2. 范围

### 2.1 本次必须修改

- 标题栏 `calls N` 的语义。
- completed 项的折叠触发条件。
- 多个 completed 项同时存在时，选择哪些项折叠的规则。
- 对应单元测试。

### 2.2 本次不得修改

- 最终 `web_search` 回显 card 的投递机制。
- `sendMessage`、`appendEntry`、context filtering 或 custom message renderer 行为。
- overlay 关闭触发语义。
- OpenAI Responses 请求注入、stream observer、late policy binding。
- `image_generation` 逻辑。

## 3. 术语

- **call：** 一个可展示的 `web_search_call` 状态项。只有 `statusHasVisibleDetails(status)` 为 true 的项计入。
- **累计 call 总数：** 当前 overlay 生命周期内曾经出现过的可展示 call 数量。折叠和隐藏不应降低这个数字。
- **当前可见 call：** 当前仍未 hidden 且可渲染的 call。
- **展开项：** 在 overlay 中显示完整 query / action / error 明细的项。
- **折叠项：** 只显示标题、更新时间和简短 query 摘要的 completed 项。
- **hidden 项：** 不再在 overlay 列表中渲染的 completed 项。

## 4. 计数语义

### 4.1 标题栏

标题栏中的：

```text
phase <phase>  calls <N>  elapsed <seconds>s
```

必须显示累计 call 总数。

### 4.2 计数规则

- 当一个状态项第一次变成可展示时，累计 call 总数增加。
- 同一 provider item 后续更新、归并、折叠或隐藏，不得重复计数。
- queryless placeholder 如果当前实现会在 overlay 中展示为 `waiting for provider query`，则它成为可展示项时应计入。
- 后续 final details 合并到同一个 placeholder 时，不得再次计数。
- 标题栏 `calls N` 不受 `maxCalls`、折叠、隐藏影响。
- 列表可继续只渲染当前可见项；标题总数和列表项数量允许不同。

### 4.3 数据结构建议

`LiveTracker` 应维护一个 tracker 生命周期内的累计可展示 ID 集合，例如：

```ts
private readonly seenDisplayableStatusIds = new Set<string>();
```

每次渲染 snapshot 前或状态更新后，根据 `statusHasVisibleDetails(status)` 记录首次可展示的 `status.id`。`LiveOverlaySnapshot` 增加：

```ts
interface LiveOverlaySnapshot {
  phase: LiveOverlayPhase;
  calls: LiveOverlayCallSnapshot[];
  totalCalls: number;
  startedAt: number;
  updatedAt: number;
}
```

`renderProviderToolLiveOverlay()` 使用 `snapshot.totalCalls`，并兼容旧测试 / 直接调用场景：如果 `totalCalls` 缺失，则退回 `snapshot.calls.length`。

## 5. 折叠策略

### 5.1 折叠门槛

completed 项只有在累计可展示 call 总数大于 3 时才允许折叠。

- `totalCalls <= 3`：所有当前可见 completed 项保持展开。
- `totalCalls > 3`：允许折叠 completed 项。

### 5.2 折叠对象选择

折叠选择必须满足以下优先级：

1. 非 completed 项（`queued` / `searching` / `failed`）永远保持展开。
2. completed 项中，最近更新的项优先保持展开。
3. completed 项中，较旧的项优先折叠。
4. overlay 尽量保留最多 3 个展开项；非 completed 项优先占用展开名额，剩余展开名额给最近的 completed 项。

示例：

```text
searching S
completed C
completed B
completed A
```

`totalCalls = 4` 时：

- S 保持展开；
- C、B 保持展开；
- A 折叠。

```text
searching S2
searching S1
completed C
completed B
completed A
```

`totalCalls = 5` 时：

- S2、S1 保持展开；
- C 保持展开；
- B、A 折叠。

```text
completed C
completed B
completed A
```

`totalCalls = 3` 时：

- C、B、A 全部保持展开。

### 5.3 折叠计时器行为

现有 completed collapse timer 可以保留，但 timer 到期时不能仅凭时间直接折叠该项。必须重新计算当前折叠策略：

- 如果 `totalCalls <= 3`，不折叠。
- 如果该 completed 项属于需要保持展开的最近项，不折叠。
- 如果该 completed 项属于较旧 completed 项，折叠。

这能避免第 4 个 call 出现前，前 3 个 completed 因 timer 到期提前折叠。

### 5.4 新 call 到达后的重新计算

当第 4 个可展示 call 到达时，应重新计算折叠状态：

- 已完成且较旧的 completed 项可以在下一次 render 前变为 collapsed。
- 不要求等待这些旧 completed 项各自的原始 collapse timer 再触发。
- 不应折叠当前仍在 searching 的项。

实现可以在每次 status 更新后调用一个统一方法，例如 `reconcileCompletedVisibility()`，根据当前总数和更新时间重新设置 completed 项的 `visibility`。

## 6. Hidden 与 overlay 生命周期

本规格不改变 overlay 关闭语义。

- overlay 的正常关闭仍由最终回显成功插入后调用 `clearLiveStatus()` 触发。
- 折叠不关闭 overlay。
- 本规格不新增「所有 completed hidden 后自动关闭 overlay」语义。
- 如果当前代码仍存在旧的 all-hidden auto-close 逻辑，只能在实现本规格时保持或移除为与「最终回显关闭 overlay」一致；不得把 all-hidden auto-close 当成本规格的新需求或验收依据。

隐藏行为可以保持现状，但标题栏累计 `calls N` 不得因 hidden 项减少。

## 7. 测试要求

至少新增或更新以下测试：

1. **标题累计计数不随隐藏减少**
   - 创建 4 个 displayable `web_search_call`。
   - 触发部分 completed hide。
   - 断言标题仍包含 `calls 4`。
   - 断言隐藏项不一定在列表中出现。

2. **3 个及以下 completed 不折叠**
   - 创建 3 个 completed call。
   - 触发 collapse timer。
   - 断言 3 个 query 仍以展开格式显示，例如 `│ query ...`。
   - 断言没有 completed 项只剩 collapsed summary。

3. **第 4 个 call 到达后折叠最旧 completed**
   - 先创建 3 个 completed call，触发 collapse timer 后仍保持展开。
   - 再创建第 4 个 call。
   - 断言最旧 completed 折叠，最近 completed 或 searching 项保持展开。

4. **非 completed 项不折叠**
   - 创建 2 个 searching 和 3 个 completed。
   - 断言 searching 项保持展开。
   - 断言 completed 中较旧项折叠，最近 completed 保持展开。

5. **requestRender 失绑回归测试保留**
   - 保留现有 `keeps overlay alive when runtime requestRender is an unbound method` 覆盖，不因本次折叠重构丢失。

## 8. 文档要求

如果 README 或 `docs/runtime-compatibility.md` 已描述 live overlay completed timing，需要同步说明：

- 标题 `calls N` 是累计可展示 call 总数；
- completed 折叠只在累计 call 数大于 3 时启用；
- 非 completed 项优先保持展开，较旧 completed 优先折叠。

## 9. 验收标准

- 用户在 TUI 中看到 overlay 时，标题栏 `calls N` 不再因为 completed 项折叠或隐藏而下降。
- 1～3 个 completed 项不会折叠。
- 第 4 个及之后的 call 出现时，旧 completed 项会折叠，正在进行中的项保持展开。
- overlay 关闭时机不因本规格变化。
- 相关单元测试通过。
- 全量测试通过。
