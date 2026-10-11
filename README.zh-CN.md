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
- 显示回复、进度、审批、MCP 输入请求和受支持的附件。
- 协调 Session 所有权，避免多个客户端同时暗中操作同一个 Session。
- 使用本地 SQLite 保存 Bridge 路由状态和消息元数据。

## 支持的客户端

| 客户端 | 主要用途 | 当前支持 |
| --- | --- | --- |
| Web | 主要工作台 | 项目、Session、消息、图片上传、审批和连接接管。 |
| Telegram | 移动端访问 | 文本对话、Session 命令、进度消息和审批。 |
| Slack | 团队对话 | Thread 路由、审批、图片和可选语音转写。 |

Web 可以独立运行，Telegram 和 Slack 是可选适配器。启用的客户端共享同一个
Bridge 进程和 Codex Runtime。

## 兼容性

Codex App Server 的 Schema 与具体版本相关。当前 Bridge 基线验证日期为
2026-10-11：

**本项目最新验证的 Codex CLI 版本：`0.160.0`。**

| 组件 | 支持范围 | 已验证版本 |
| --- | --- | --- |
| Codex CLI | `>=0.158.0 <0.161.0` | `0.160.0` |
| Node.js | `22.22.x` | `22.22.0` |
| Yarn | `4.8.x` | `4.8.1` |

下限来自代码中保留的 Codex `0.158` 兼容行为，最新的实际协议验证使用
`0.160.0`。范围外版本应先通过协议检查和项目测试，再视为已经验证。

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

## 快速开始：仅启用 Web

1. 按照[官方说明](https://developers.openai.com/codex/cli/)安装 Codex CLI，
   运行 `codex` 并完成登录。
2. 克隆本仓库并进入项目目录。
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
3. 选择 Session，并明确取得控制权后再读取或发送消息。
4. 发送消息、上传图片，或处理审批和 MCP 输入卡片。

需要了解的行为：

- 打开另一个浏览器不会自动获得控制权。新窗口可以明确接管 Web 连接；接管后
  旧窗口会立即失去连接权。
- 切换 Session 不会中断正在运行的任务。
- 刷新页面时会尽量恢复选中的 Session，并重新读取最多五条用户/助手消息；
  临时进度和统计可能丢失。
- 选中的 Session 会保存在 URL 中，因此刷新和浏览器前进后退可以保留目标，
  但不会暗中取得所有权。
- Bridge 确认安全时，可以从 Session 菜单把所有权释放给外部 Codex 客户端。

## 启用 Telegram 或 Slack

直接启动时使用 `.env`；使用 PM2 或 Windows 服务脚本时使用 `.env.bridge`。

Telegram：

- 设置 `TELEGRAM_BOT_TOKEN`。
- 可用 `TELEGRAM_ALLOWED_CHAT_IDS` 限制访问。

Slack：

- 设置 `SLACK_ENABLED=true`。
- 设置 `SLACK_BOT_TOKEN`、`SLACK_APP_TOKEN` 和 `SLACK_SIGNING_SECRET`。
- 可用 `SLACK_ALLOWED_CHANNEL_IDS` 限制 Channel。
- 语音转写还需要 `OPENAI_API_KEY`。

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

## 常用命令

```bash
corepack yarn check
corepack yarn lint
corepack yarn test
corepack yarn build
corepack yarn start
corepack yarn verify:codex --scenario protocol --json
```

## 更多文档

- [Web API 和行为](docs/web-api.md)
- [运维和适配器配置](docs/operations.md)
- [开发和协议验证](docs/development.md)

## License

[MIT](LICENSE)

贡献内容使用同一协议，详情参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

Codex Bridge 是独立的社区项目，与 OpenAI 不存在隶属、认可或赞助关系。
