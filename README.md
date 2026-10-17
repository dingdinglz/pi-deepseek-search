# pi-deepseek-search

将 DeepSeek 的 [Search / Fetch API](https://api-docs.deepseek.com/zh-cn/guides/search) 接入 Pi。两个工具，直接调用 HTTP API，不经过额外模型，不依赖浏览器或 MCP。

## 使用

需要 Node.js 22+、当前 `@earendil-works` 版 Pi（已在 1.3.0 验证）和有余额的 DeepSeek API key。

```bash
# 在本项目目录临时加载
pi -e ./index.ts

# 或安装到 Pi，之后正常启动 pi 即可
pi install /绝对路径/pi-deepseek-search
```

首次使用，在 Pi 的 TUI 中运行：

```text
/deepseek-key
```

在弹出的遮罩输入框中粘贴 key，按 Enter 保存，Esc 取消。保存后立即生效，无需重新加载；重启 Pi 后仍可使用。再次运行该命令可以替换 key，`/deepseek-key clear` 确认后删除已保存的 key。不要把 key 写在命令后面，命令不接受 key 参数。保存时只检查格式，不会发起计费请求；是否有效由后续 API 调用确认。

之后直接说“搜索 DeepSeek Search API 的使用方式”或“读取这个网页：https://…”。

key 保存于 Pi 用户目录下的 `deepseek-search/key.json`（默认 `~/.pi/agent/deepseek-search/key.json`），**本地明文存储**，目录权限 `0700`、文件权限 `0600`。输入内容不会回显或主动写入对话、命令历史、项目文件；有本机文件读取权限的程序仍然能够读取该文件。自定义 Pi 用户目录时，key 会随该目录隔离。

插件不再读取 `DEEPSEEK_API_KEY` 或 `.env`，也不修改 Pi 的模型供应商凭据。无 key 时工具会提示运行 `/deepseek-key`。命令仅在 TUI 可用，RPC/print/JSON 模式的工具可以使用事先保存的 key。

查询、原始问题、本地化 IP（如提供）和目标 URL 会发送给 DeepSeek；不要传入敏感信息。

## 工具

### `deepseek_search`

```json
{"query":"DeepSeek site:github.com lang:zh after:2026-01-01","count":5}
```

| 参数 | 说明 |
| --- | --- |
| `query` | 必填，1–128 个 Unicode 字符，不能全为空白 |
| `count` | 可选，1–50，默认 10 |
| `need_content` | 可选，默认 `false`；需要时附带可获取的网页正文 |
| `ori_question` | 可选，原始用户问题，1–128 字符，允许 `null` |
| `localization` | 可选，用于优先返回本地结果的 IP 地址 |

搜索语法沿用官方 API：`site:`、`-site:`、`-关键词`、`-"短语"`、`"精确短语"`、`lang:`、`after:`、`before:`。多个站点可以用 `OR` 连接。

返回标题、链接、日期、摘要、相关性和权威性信息。默认使用长摘要，缺失时回退到短摘要；无结果正常返回，不视为失败。

### `deepseek_fetch`

```json
{"url":"https://api-docs.deepseek.com/zh-cn/guides/search"}
```

抓取单个 HTTP(S) 网页，返回标题和 Markdown。URL 不超过 8192 字符，不能携带用户名或密码。部分站点可能无法抓取；此时显示明确错误，不伪造页面内容。

## 行为

- 终端折叠时显示结果数或页面标题/大小，展开显示正文；支持错误回显，过滤终端控制字符。
- 提供 `outputSchema` 和完整 `structuredContent`，可供 Pi codemode 调用；不捏造模型 token 用量。
- 模型可见文本超过 400 行或 30 KiB 时截断，完整文本保存到系统临时目录 `pi-deepseek-*/output.md`，结果中给出路径，可用 `read` 继续读取。文件权限为 `0600`，不会自动删除，便于会话后续使用。
- 总超时 60 秒，取消会中断 HTTP 请求和重试等待。仅对 HTTP 408、429、5xx 重试，最多共 3 次，并尊重 `Retry-After`。网络错误不自动重试，避免不确定的重复计费。
- 401 提示检查 key，402 提示充值，403/404 提示策略拒绝或页面不可用。其它不可重试错误直接返回。
- 工具没有共享可变状态，可并发执行；账号 QPS 仍受 DeepSeek 限制。

依官方文档，两个 API 均按成功且产生内容的请求计费，当前为 **¥5 / 1000 次**。搜索条数不影响单次价格。重试可能产生额外请求，以平台最终账单为准。

## 开发与验证

```bash
npm ci
npm run check
npm test

# 先在 Pi TUI 用 /deepseek-key 保存 key
# 显式发起三次真实请求，可能计费；不会由 npm test 自动触发
npm run test:live
```

自动测试覆盖参数、Unicode、请求格式、错误脱敏、有限重试、取消、超时、结果截断、结构化输出、渲染、Pi 实际扩展加载器，以及 key 的持久化、权限、替换、删除、取消、遮罩输入和环境变量禁用。

真实 Pi TUI 已通过伪终端验证：运行 `/deepseek-key`、粘贴输入、保存成功，终端输出中没有 key 明文，文件权限为 `0600`。

API 实测结果（通过真实 TUI 的 `/deepseek-key` 在隔离的 Pi 用户目录保存临时 key，再由独立进程读取并调用；测试后已删除临时目录）：

| 场景 | 结果 |
| --- | --- |
| Pi 1.3.0 实际加载器 | 成功注册两个工具及 `/deepseek-key`，无加载错误或警告 |
| 搜索，`count=3` | 3 条结果，正文为空，约 1576 ms |
| 搜索，`need_content=true` | 1 条结果，正文 17464 字节，约 465 ms |
| 抓取本项目引用的官方指南 | 标题“网页搜索与抓取”，Markdown 9352 字节，约 484 ms |
| 类型检查 / 自动测试 | 通过 / 36 项通过 |

延迟和搜索结果随网络及索引变化。实时验证脚本通过 Pi 加载扩展后直接调用注册的工具，不额外发起模型对话。

## 实现

- `index.ts`：工具注册与简洁终端展示。
- `src/client.ts`：鉴权、参数校验、HTTP、取消与错误处理。
- `src/key-command.ts`：`/deepseek-key` 命令及遮罩输入。
- `src/credentials.ts`：key 的私有文件存储与原子替换。
- `src/schemas.ts`：输入和结构化输出定义。
- `src/output.ts`：结果排版与长内容落盘。

工具注册、错误回显和折叠/展开展示参考了 [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) 的实现方式。Pi 提供的依赖声明为 peer dependencies，不打包宿主运行时。
