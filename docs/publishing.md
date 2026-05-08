# omp-openai-provider-tools 发布流程

这份文档只覆盖 `omp-openai-provider-tools` 的 npm 发布链路。发布前必须使用干净工作区，并重新运行本次发布对应的验证命令；不要复用旧日志。

## 手动首发

首次发布时，先用本地 npm 账号完成首发。首发成功后再配置 npm Trusted Publisher，把后续发布交给 GitHub Actions。

```powershell
bun test
bun pm pack --dry-run
npm pack --dry-run --json
npm view omp-openai-provider-tools version --json
$version = node -p "require('./package.json').version"
npm view "omp-openai-provider-tools@$version" version --json
npm whoami
npm publish --access public
```

检查要点：

- `bun test` 必须是当前发布前刚跑出的结果。
- `bun pm pack --dry-run` 和 `npm pack --dry-run --json` 都必须通过；以 `npm pack --dry-run --json` 的文件列表作为 npm 实际发布内容依据。
- `npm view "omp-openai-provider-tools@$version" version --json` 如果返回版本号，说明当前版本已经发布，不能再次发布同一版本。
- `npm whoami` 必须是计划用于首发的 npm 账号。
- `npm publish --access public` 是手动首发的最后一步。

## 发布前 fresh 验证

每次首发、补发或重新触发发布前，都重新跑：

```powershell
bun test
bun pm pack --dry-run
npm pack --dry-run --json
$version = node -p "require('./package.json').version"
npm view "omp-openai-provider-tools@$version" version --json
npm whoami
```

重点确认：

- 测试为 `0 fail`。
- dry-run 文件只包含允许发布的包内容：`package.json`、`README.md`、`docs/runtime-compatibility.md` 以及 `src/` 运行时代码。
- 当前版本没有出现在 npm registry 中，或者你明确是在验证已发布版本会被 workflow 跳过。
- npm 登录账号符合发布预期。

## npm Trusted Publisher 设置与验证

手动首发成功后，配置 npm Trusted Publisher。将 `<owner>/<repo>` 替换为实际 GitHub 仓库，例如 `your-org/omp-openai-provider-tools`。

```powershell
npx --yes npm@latest trust github omp-openai-provider-tools --file release.yml --repo <owner>/<repo> --yes
npx --yes npm@latest trust list omp-openai-provider-tools --json
```

说明：

- `release.yml` 指 `.github/workflows/release.yml`。
- 第一条命令把 GitHub Actions 的 release workflow 注册为 npm Trusted Publisher。
- 第二条命令确认 trusted publisher 已经绑定到正确仓库。
- 当前仓库如果还没有 GitHub remote，先配置 remote，再执行 trust 命令。

## 后续 GitHub Actions 发布

Trusted Publisher 配好后，后续发布通过 GitHub Release 触发 `.github/workflows/release.yml`。

workflow 会执行：

1. checkout 代码；
2. 安装 Node 24、最新 npm 和 Bun；
3. `bun install --frozen-lockfile`；
4. `bun test`；
5. `npm pack --dry-run --json`；
6. 检查 `package.json` 中的当前版本是否已经发布；
7. 未发布时执行 `npm publish --access public`。

如果当前版本已经发布，`Publish` step 会跳过。这是预期行为，不是失败。

## GitHub Release 创建与验证

创建 Release 时使用固定版本号和发布说明文件。以下命令中的 `<owner>/<repo>`、版本号和 notes 文件需要按实际发布替换。

```powershell
gh release create v0.1.0 --repo <owner>/<repo> --target master --title "v0.1.0" --notes-file docs/release-notes-v0.1.0.md --latest
```

验证点：

- Release 创建成功后，确认 `Release` workflow 被触发。
- workflow 的 `Test` 和 `Pack dry run` 必须通过。
- 首发后补建 GitHub Release 时，`Publish` step skipped 是预期结果，因为 npm 端已有同版本包。
- 非首发发布时，workflow 应完成测试、dry-run 和发布。

## 部分失败恢复

常见半失败状态：

1. `npm publish` 已成功，但 GitHub Release 失败：修复 Release 命令或发布说明文件后重新创建 Release。此时 workflow 的 `Publish` step skipped 是预期结果。
2. GitHub Release 已创建，但 workflow 失败：修复 Trusted Publisher、workflow 或测试问题后，重新触发 release workflow。不能只把 npm 包发布成功视为整条链路完成。
3. workflow 在发布前失败：修复失败原因，重新触发 workflow；不要手动跳过测试或 dry-run。
