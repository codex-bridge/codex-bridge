# Codex Bridge

[English](README.md)

Codex Bridge 让你通过浏览器、Telegram 或 Slack 继续使用同一批本地 Codex
Session。它运行在 Codex CLI 旁边，通过官方 Codex App Server 协议通信，并
协调当前由哪个客户端控制每个 Session。

项目面向自托管、单用户或可信团队环境。Codex 的登录、模型、权限、Skill、
MCP Server 和项目配置仍由 Codex 管理；Bridge 只增加访问本地 Runtime 的
入口。

Codex Bridge 于 2026 年 3 月开始开发，在首次公开发布前经历了超过 650 个
提交。

## 项目能力

- 从局域网浏览器、Telegram 或 Slack 继续已有 Codex Session。
- 切换项目和 Session 时，不中断已经运行的任务。
- 显示回复、工作流活动、审批、问题、MCP 输入请求和受支持的附件。
- 协调 Session 所有权，避免多个客户端同时暗中操作同一个 Session。
- 使用本地 SQLite 保存 Bridge 路由状态和消息元数据。

## 支持的客户端

| 客户端 | 主要用途 | 当前支持 |
| --- | --- | --- |
| Web | 主要工作台 | 项目、Session、消息、图片上传、审批和连接接管。 |
| Telegram | 移动端访问 | 私聊和群组 Topic、图片、可选音频转写、阶段汇总和审批。 |
| Slack | 团队对话 | Thread 路由、审批、图片和可选语音转写。 |

Web 可以独立运行，Telegram 和 Slack 是可选适配器。启用的客户端共享同一个
Bridge 进程和 Codex Runtime。

## 兼容性

Codex App Server 的 Schema 与具体版本相关。当前 Bridge 基线验证日期为
2026-11-19：

**本项目最新验证的 Codex CLI 基线：`0.170.0`。**

| 组件 | 支持范围 | 已验证版本 |
| --- | --- | --- |
| Codex CLI | `>=0.170.0 <0.171.0`（推荐） | `0.170.0` |
| Node.js | `>=22.23.5 <23` | `22.23.5` |
| Yarn | `4.8.x` | `4.8.1` |

使用 `package.json` 中固定的 Node 和 Yarn 版本。Codex 推荐范围采用已经验证
的 `0.170` 协议系列，实际测试的仅为 `0.170.0`，不代表所有旧版本和其他
Provider 均已兼容。参见[验证范围与已知限制](docs/codex-compatibility.md)
以及[运行环境配置](docs/operations.md#pm2-lifecycle)。

官方资料：[安装 Codex CLI](https://developers.openai.com/codex/cli/)；
[Codex App Server](https://developers.openai.com/codex/app-server/)。

## 安全模型

Web UI 没有用户账号或面向公网的认证层。请只监听本机或可信局域网地址；远程
访问应通过你自己的 VPN，不要把 Bridge 直接暴露到公网。

如需报告安全漏洞，请遵循 [SECURITY.md](SECURITY.md) 中的流程。

浏览器连接权和 Codex Session 所有权是两套独立机制。同一时间只有一个浏览器
窗口持有 Web 连接权，也只有真正拥有 Session 的客户端才能读取对话或执行
操作。

## 前置条件

- 已安装并完成登录的 Codex CLI；运行 Bridge 和 Codex 的系统用户应相同。
- Git。
- `package.json` 中固定的 Node 和 Yarn 版本，推荐使用 Volta。
- 至少启用 Web、Telegram 或 Slack 中的一个入口。

## 让 Codex 帮你配置

如果希望由 Codex 引导配置，而不是手动执行下面的步骤，可以克隆本仓库，在
仓库目录中打开 Codex，然后粘贴：

<details>
<summary>展开配置提示词</summary>

```text
帮我配置并运行 Codex Bridge，让我可以通过浏览器与 Codex 对话。
先阅读 README.zh-CN.md、package.json、.env.example 和 docs/operations.md；
如果是 Windows，使用仓库提供的对应脚本。

检查操作系统、项目固定的 Node/Yarn 版本，以及 Codex CLI 的兼容性和认证状态。
复用我已有的 Codex 配置；如果需要登录或凭据，引导我完成，不要让我把密钥
粘贴到对话中。安装缺失的项目依赖，并构建后端与 Web UI。

只启用 Web，禁用 Telegram 和 Slack。直接启动时使用 .env，使用仓库的进程
管理脚本时使用 .env.bridge。默认监听 127.0.0.1:8787，需要局域网访问时先问我。
这个服务没有公网认证，不要暴露到公网。保留已有配置和数据；修改正在运行的
安装、安装系统工具，以及调整防火墙、证书信任或自启设置之前，先征得我同意。

启动 Bridge，避免重复实例，并让服务在配置完成后继续运行。检查
/api/web/health 和网页是否能加载，不要仅凭健康接口成功就宣称可以对话；遇到
阻碍应明确说明。给我准确的访问地址和停止、重启方法，能够打开网页就帮我打开。
说明如何连接当前浏览器窗口、添加项目目录、创建或选择 Session 并明确取得
控制权，让我可以发送第一条消息。
```

</details>

## 快速开始：仅启用 Web

1. 按照[官方说明](https://developers.openai.com/codex/cli/)安装 Codex CLI，
   运行 `codex` 并完成登录。
2. 克隆本仓库并进入项目目录：

   ```bash
   git clone https://github.com/codex-bridge/codex-bridge.git
   cd codex-bridge
   ```

3. 安装依赖并构建后端与 Web UI：

   ```bash
   corepack yarn install --immutable
   corepack yarn build
   ```

4. 复制配置示例。它默认只在 `127.0.0.1:8787` 启用 Web 工作台：

   ```bash
   cp .env.example .env
   ```

5. 启动 Bridge：

   ```bash
   corepack yarn start
   ```

6. 打开 <http://127.0.0.1:8787/>。

如需从可信局域网访问，将 `WEB_HOST` 改为机器的局域网 IP 或 `0.0.0.0`，再从
其他可信设备访问相同端口。当前 Host 校验只接受 IP 地址和 `localhost`，不
接受自定义 DNS Hostname。

## 使用 Web 工作台

1. 将当前浏览器窗口连接到 Bridge 服务。
2. 添加 Bridge 所在机器上已经存在的项目目录。
3. 创建或选择 Session，然后明确取得控制权。
4. 发送消息、上传图片，或处理审批、问题和 MCP 输入卡片。

同一时间只有一个浏览器窗口持有 Web 连接权。其他窗口可以明确接管，原窗口
随即失去访问权。选中的 Session 会保存在 URL 中，刷新时保留目标，但不会
暗中取得控制权。Bridge 允许释放时，也可从 Session 菜单交还给外部 Codex。

## 对话行为

- 切换 Session 不会中断已接受的任务。同一个 Session 在 Web、Slack Thread
  和 Telegram Topic 之间，同一时间只有一个入口持有操作权。
- 取得 Session 后恢复最多五条最近的用户/助手消息。临时进度统计不构成完整
  的对话存档。
- Slack 和 Web 保留实时工作流活动。Telegram 只显示阶段结束汇总，隐藏 Run
  块，Working 状态变化至少间隔 20 秒合并更新，计时不会持续刷新。
- 成功的自动审批审核保持静默；审核异常、审批请求和问题仍会显示。MCP 连接
  问题汇总到 Actions，Codex 版本提醒会出现在符合条件的 Actions 之前。

## 启用 Telegram 或 Slack

直接启动时使用 `.env`；使用 PM2 或 Windows 服务脚本时使用 `.env.bridge`。

详细配置步骤：

- [Telegram Bot 配置指南（英文）](docs/telegram-setup.md)
- [Slack App 配置指南（英文）](docs/slack-setup.md)

Telegram：

- 设置 `TELEGRAM_BOT_TOKEN`。
- 可用 `TELEGRAM_ALLOWED_CHAT_IDS` 限制访问。

Slack：

- 设置 `SLACK_ENABLED=true`。
- 设置 `SLACK_BOT_TOKEN`、`SLACK_APP_TOKEN` 和 `SLACK_SIGNING_SECRET`。
- 可用 `SLACK_ALLOWED_CHANNEL_IDS` 限制 Channel。

Telegram 和 Slack 的可选语音/音频转写都需要 `OPENAI_API_KEY`，并可设置
`AUDIO_TRANSCRIPTION_MODEL`（默认 `gpt-4o-mini-transcribe`）。这使用独立的
转写 API，与 Codex CLI 登录分开；图片输入不需要这个 Key。支持的文件类型和
大小限制见对应配置指南。

模型、Provider、Reasoning Effort、审批策略、Sandbox、Service Tier、
Personality、Skill、MCP 和 Feature Flag 仍属于 Codex 配置。请在
`~/.codex/config.toml` 或可信项目的 `.codex/config.toml` 中设置。

## Windows 安装

在仓库根目录使用 Windows PowerShell 5.1 或更新版本运行：

```powershell
.\scripts\windows\win-install-codex-cli.ps1
.\scripts\windows\win-install-bridge-dependencies.ps1
Copy-Item .env.example .env.bridge
.\scripts\windows\win-start-bridge.ps1
```

其他脚本：

- `win-update-and-build.ps1`：Fast-forward 更新代码并重新构建。
- `win-start-and-enable-autostart.ps1`：启动 Bridge，并创建或更新当前用户的
  登录自启任务，不重复启动进程。
- `win-stop-and-disable-autostart.ps1`：停止当前 Checkout 的 Bridge 进程并
  删除自启任务。

## 后台运行

在 macOS 或 Linux 上，可以选择使用 PM2 管理进程。将配置复制到
`.env.bridge`，单独安装 PM2，然后运行：

```bash
corepack yarn pm2:start
corepack yarn pm2:status
corepack yarn pm2:logs
```

生命周期操作使用 `corepack yarn pm2:restart`、`corepack yarn pm2:stop` 或
`corepack yarn pm2:delete`。不要使用相同的 Telegram 或 Slack 凭据运行两个
Bridge 实例。

## 更新已有安装

```bash
git pull --ff-only
corepack yarn install --immutable
corepack yarn build
```

构建成功后再重启服务。Windows 对应脚本是
`scripts/windows/win-update-and-build.ps1`；它只构建，不会重启 Bridge。

如果 Node 版本发生变化，或启动时出现 `NODE_MODULE_VERSION` 不匹配，请运行：

```bash
corepack yarn native:rebuild
```

## 数据和备份

运行数据默认保存在已忽略的 `workspaces/` 目录中。移动或替换安装前，请保存
SQLite 数据库和仍然需要的附件。

执行破坏性迁移前，Bridge 会创建通过完整性检查的 SQLite 备份。可以先查看
待执行迁移而不修改数据库：

```bash
corepack yarn db:migrate --database /absolute/path/bridge.sqlite --dry-run
```

运行验收完成前，请保留命令报告的迁移备份。

## 更多文档

- [Web API 和行为](docs/web-api.md)
- [运维和适配器配置](docs/operations.md)
- [开发和协议验证](docs/development.md)

## License

[MIT](LICENSE)

贡献内容使用同一协议，详情参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

Codex Bridge 是独立的社区项目，与 OpenAI 不存在隶属、认可或赞助关系。
