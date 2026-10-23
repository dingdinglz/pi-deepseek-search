# pi-deepseek-search

为 [Pi](https://github.com/earendil-works/pi) 提供可切换 **DeepSeek / OpenAI Codex** 的网页搜索与读取工具。两个供应商均直接调用网页工具接口，无需浏览器、MCP 或额外的模型对话。

| 供应商 | 工具 | 用途 |
| --- | --- | --- |
| DeepSeek（默认） | `search` / `fetch` | 搜索结果及 Markdown 正文，沿用现有 API key |
| OpenAI Codex | `search` / `fetch` | 直接搜索及打开网页，复用 Pi 的 `openai-codex` 登录 |

始终只保留 `search` 和 `fetch` 两个工具，不维护供应商前缀工具或别名。切换配置时替换同名工具的参数和输出定义，仅向模型展示当前可用的能力；工具名称、说明、参数描述及扩展附加的输出元信息不含供应商名称。供应商独立于当前对话模型，不自动跟随模型切换，也不会在失败时自动改用另一供应商。

[安装](#安装) · [快速开始](#快速开始) · [工具参数](#工具参数) · [隐私与计费](#隐私与计费) · [开发](#开发)

## 安装

默认从 GitHub 安装：

```bash
pi install git:github.com/dingdinglz/pi-deepseek-search
```

需要 Node.js 22.19+、`@earendil-works/pi-coding-agent` 版 Pi（1.3.0+），以及 DeepSeek API key 或 Pi 中已有的 OpenAI Codex 登录。安装后启动 Pi；如果已有会话正在运行，执行 `/reload` 加载扩展。

只在当前项目使用时，加上 `--local`：

```bash
pi install git:github.com/dingdinglz/pi-deepseek-search --local
```

项目级安装需要授予 Pi 对该项目的信任。更新或卸载：

```bash
pi update git:github.com/dingdinglz/pi-deepseek-search
pi remove git:github.com/dingdinglz/pi-deepseek-search
```

项目级安装卸载时也需加上 `--local`。卸载扩展不会删除已保存的 key；如需清除，请先运行 `/deepseek-key clear`。

## 快速开始

### 1. 选择供应商

默认使用 DeepSeek，已有供应商及凭证配置继续有效；工具名统一为 `search` 和 `fetch`。在 Pi 中切换：

```text
/web-provider deepseek
/web-provider openai
```

不带参数运行 `/web-provider` 会显示当前配置，并在有 UI 时打开选择菜单。切换立即生效，保存到 Pi 用户目录的 `deepseek-search/settings.json`，重启或 `/reload` 后保留。此文件只包含供应商和模型 ID，不包含凭证。配置损坏时两个工具拒绝执行并报错；请修复或移除文件后重新加载，不会静默回退。

**OpenAI 模式：**先通过 Pi 的 `/login` 选择 `openai-codex` 完成登录；已登录则无需再提供 key。默认模型为 `auto`：从 Pi 当前登记的 `openai-codex` 模型列表选择第一个兼容模型，不绑定可能下线的固定版本。也可指定列表中的模型，例如：

```text
/web-provider openai gpt-5.5
/web-provider openai auto
```

切换命令只保存设置，不进行联网验证。首次工具调用才验证模型、解析登录凭证并请求服务。

> OpenAI 使用最新 [Codex 源码中的独立 `alpha/search` 接口](https://github.com/openai/codex/blob/8531184b49bcb160175a84e140b659a83a426df7/codex-rs/codex-api/src/endpoint/search.rs)，不是普通 OpenAI API key 的公共 Search/Fetch API。它是 alpha 接口，账号权限、协议和可用性可能变化。网页输出可能只是带行号的片段，不保证完整 Markdown；本插件不额外调用模型改写结果。

### 2. 配置 DeepSeek API key（仅 DeepSeek 模式）

在 Pi 的 TUI 中运行：

```text
/deepseek-key
```

在遮罩输入框中粘贴 key，按 Enter 保存，Esc 取消。保存后立即生效，重启 Pi 后仍可使用。

- 替换 key：再次运行 `/deepseek-key`。
- 删除 key：运行 `/deepseek-key clear`，确认后删除。
- 不要把 key 写在命令后面；命令不接受 key 参数。

保存时只检查格式，不发起计费请求。是否有效由后续 API 调用确认。

### 3. 搜索或读取网页

直接向 Pi 提问：

```text
搜索 DeepSeek Search API 的使用方式，优先查看官方文档。
```

```text
读取这个网页并总结主要内容：https://api-docs.deepseek.com/zh-cn/guides/search
```

Pi 可根据任务调用搜索或抓取工具。搜索结果带有来源链接；终端折叠时显示结果数或页面标题，展开可查看正文。

## 工具参数

工具名保持不变，**参数定义随配置动态切换**。基础调用为 `search({"query":"…"})` 和 `fetch({"url":"https://…"})`；当前不支持的参数不会出现在工具声明中，参数描述只解释用途，不标注供应商。切换后沿用旧参数会报错，旧定义也不会将请求发送给新接口。以下按配置列出可用参数，供使用者参考。

### `search`（DeepSeek 模式）

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

### `fetch`（DeepSeek 模式）

```json
{"url":"https://api-docs.deepseek.com/zh-cn/guides/search"}
```

`url` 为必填的 HTTP(S) 网页地址，不超过 8192 字符，不能携带用户名或密码。每次抓取一个网页，返回标题和 Markdown。部分站点可能无法抓取，此时返回明确错误，不伪造页面内容。

### `search`（OpenAI 模式）

```json
{"query":"Codex web search","recency":30,"domains":["github.com"],"response_length":"long"}
```

- `query`：必填，1–4000 个 Unicode 字符，不能全为空白。
- `recency`：可选，最近多少天（正整数）。
- `domains`：可选，限定搜索域名列表。
- `response_length`：`short` / `medium` / `long`，默认 `long`。

直接发送 `commands.search_query`，不模拟 DeepSeek 的 `count`、`need_content` 或评分字段，也不保证 DeepSeek 专有搜索语法。

### `fetch`（OpenAI 模式）

```json
{"url":"https://example.com","lineno":0,"response_length":"long"}
```

URL 校验同 DeepSeek。直接发送 `commands.open`，`lineno` 为非负整数，默认 0；需要继续读取时，使用同一 URL 和服务输出中的后续行号。

OpenAI 配置下，两个工具返回 `{output, results?}`，不附加供应商或模型标识。`output` 保留服务原文，包括来源链接、片段和可能的页面不可用说明；`results` 若有则保留服务返回的 JSON，不强行转成 DeepSeek 排名。不会返回无用的 `encrypted_output`，也不伪造 token 用量。HTTP 成功但服务正文包含页面错误时，该说明原样交给调用方。

## 隐私与计费

### key 存储

key 保存于 Pi 用户目录下的 `deepseek-search/key.json`，默认路径为 `~/.pi/agent/deepseek-search/key.json`。自定义 Pi 用户目录时，key 随该目录隔离。

这是**本地明文存储**，目录权限为 `0700`，文件权限为 `0600`。输入内容不会回显或主动写入对话、命令历史、项目文件；有本机文件读取权限的程序仍然能够读取该文件。

DeepSeek 模式不读取 `DEEPSEEK_API_KEY` 或 `.env`，也不修改 Pi 的模型供应商凭据。无 key 时工具会提示运行 `/deepseek-key`。该命令仅在 TUI 可用；RPC、print、JSON 模式的工具可使用事先保存的 key。

### OpenAI 登录凭证

扩展每次调用通过 `ctx.modelRegistry.getApiKeyAndHeaders()` 解析 `openai-codex` 凭证，过期凭证由 Pi 刷新。不会自行读取、复制或保存 `auth.json`，不会将 token 写入插件配置、输出或日志。普通 OpenAI API key 不适用于这个接口。

请求只发送到固定的 `https://chatgpt.com/backend-api/codex/alpha/search`，不跟随 HTTP 重定向，不使用自定义模型 base URL 或代理鉴权头。目标网页 URL 是请求数据，不是携带 OAuth 凭证的请求目的地。

### 发送的数据与费用

仅向所选供应商发送查询、过滤参数或目标 URL，不发送 Pi 对话历史。DeepSeek 还会收到原始问题和本地化 IP（如提供）；OpenAI 会收到模型 ID、随机请求 ID 和输出长度预算。请勿传入敏感信息。

依[官方文档](https://api-docs.deepseek.com/zh-cn/guides/search)，两个 API 均按成功且产生内容的请求计费，文档标价为 **¥5 / 1000 次**，搜索条数不影响单次价格。重试可能产生额外请求，价格及扣费以平台最新说明和最终账单为准。

OpenAI 的账号额度及费用以 Codex 服务实际规则为准；不假定免费，也不套用 DeepSeek 单价。这里没有额外的 Responses 模型调用，但 alpha 服务内部如何处理及计费不由本插件保证。

## 输出与错误处理

- 提供 `outputSchema` 和完整 `structuredContent`，可供 Pi codemode 调用；不捏造模型 token 用量。
- 模型可见文本超过 400 行或 30 KiB 时截断。完整文本保存到系统临时目录 `pi-web-*/output.md`，结果中给出路径，可用 `read` 继续读取。文件权限为 `0600`，不会自动删除，使用后可自行清理。
- 两种供应商的 HTTP 请求超时均为 60 秒，支持取消。Pi 的凭证解析/刷新先于 OpenAI HTTP 请求，刷新由宿主负责。
- DeepSeek 仅对 HTTP 408、429、5xx 重试，最多共 3 次，并尊重 `Retry-After`。网络错误不自动重试。
- OpenAI 不自动重试，避免 alpha 接口的重复请求。401 提示重新登录，403/404 提示账号或 alpha 接口不可用，429 提示限流；不回显上游错误正文。
- DeepSeek 401 提示检查 key，402 提示充值，403/404 提示策略拒绝或页面不可用。其它不可重试错误直接返回。
- 支持错误回显，过滤终端控制字符。工具没有共享可变状态，可并发执行；账号 QPS 仍受 DeepSeek 限制。

## 开发

本地开发或临时加载：

```bash
git clone https://github.com/dingdinglz/pi-deepseek-search.git
cd pi-deepseek-search
npm ci
pi -e ./index.ts
```

也可通过 `pi install /绝对路径/pi-deepseek-search` 安装本地目录。

运行检查和测试：

```bash
npm run check
npm test

# 先在 Pi TUI 用 /deepseek-key 保存 key
# 显式发起三次真实请求，可能计费；不会由 npm test 自动触发
npm run test:live

# 已在 Pi 用 /login 登录 openai-codex 后，显式进行两次真实请求
# 不修改当前供应商选择，可能消耗 Codex 账号额度
npm run test:live:openai
# 可覆盖用于测试的模型 ID
npm run test:live:openai -- gpt-5.5
```

自动测试覆盖参数、Unicode、请求格式、错误脱敏、有限重试、取消、超时、结果截断、结构化输出、渲染、Pi 实际扩展加载器，以及 key 的持久化、权限、替换、删除、取消、遮罩输入和环境变量禁用。新增覆盖 Codex 凭证解析、直接接口协议、可选/不透明结果、无跨供应商回退、供应商切换及配置持久化。

类型检查与 **88 项自动测试**通过，包含同名工具的动态参数切换、声明与输出元信息中性化、旧定义拒绝执行及配置恢复。此前使用现有 Pi Codex 登录进行了真实验证：搜索返回 7 个结构化结果、约 24 KiB 服务文本，网页读取返回 Example Domain 正文。验证中也遇到过一次网络传输失败；手动重跑成功，插件本身没有自动重试。此结果仅证明当前账号、接口版本可用，不保证所有账号均已开放。

<details>
<summary>此前 DeepSeek 版本的验证记录</summary>

类型检查与 36 项自动测试均通过。真实 Pi TUI 已通过伪终端验证：运行 `/deepseek-key`、粘贴输入、保存成功，终端输出中没有 key 明文，文件权限为 `0600`。

以下为既有 API 实测记录：通过真实 TUI 的 `/deepseek-key` 在隔离的 Pi 用户目录保存临时 key，再由独立进程读取并调用；测试后已删除临时目录。

| 场景 | 结果 |
| --- | --- |
| Pi 1.3.0 实际加载器 | 成功注册两个工具及 `/deepseek-key`，无加载错误或警告 |
| 搜索，`count=3` | 3 条结果，正文为空，约 1576 ms |
| 搜索，`need_content=true` | 1 条结果，正文 17464 字节，约 465 ms |
| 抓取本项目引用的官方指南 | 标题“网页搜索与抓取”，Markdown 9352 字节，约 484 ms |

延迟和搜索结果随网络及索引变化。实时验证脚本通过 Pi 加载扩展后直接调用注册的工具，不额外发起模型对话。

</details>

### 项目结构

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 工具注册与终端展示 |
| `src/client.ts` | DeepSeek 鉴权、参数校验、HTTP、取消与错误处理 |
| `src/openai-client.ts` / `src/openai-schemas.ts` | Codex 直接搜索接口、Pi OAuth 凭证解析、协议及参数 |
| `src/provider-command.ts` / `src/provider-settings.ts` | `/web-provider` 配置切换、持久化及同名工具刷新 |
| `src/web-schemas.ts` | 按当前能力选择中性的参数和输出定义 |
| `src/key-command.ts` | `/deepseek-key` 命令及遮罩输入 |
| `src/credentials.ts` | key 的私有文件存储与原子替换 |
| `src/schemas.ts` | 输入和结构化输出定义 |
| `src/output.ts` | 结果排版与长内容落盘 |

Pi 提供的依赖声明为 peer dependencies，不打包宿主运行时。

## 参考

- [DeepSeek Search / Fetch API](https://api-docs.deepseek.com/zh-cn/guides/search)：接口、搜索语法与计费说明。
- [Codex 独立网页工具实现](https://github.com/openai/codex/blob/8531184b49bcb160175a84e140b659a83a426df7/codex-rs/ext/web-search/src/tool.rs)、[请求/响应类型](https://github.com/openai/codex/blob/8531184b49bcb160175a84e140b659a83a426df7/codex-rs/codex-api/src/search.rs)：OpenAI alpha 接口依据。
- [Pi](https://github.com/earendil-works/pi)：扩展宿主与包安装方式。
- [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)：工具注册、错误回显、折叠/展开展示及文档组织的参考。
