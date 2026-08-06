# Codex Web Console

一个面向本地开发场景的 Codex Web 工作台。它用浏览器界面连接本地项目目录，读取和继续 Codex 历史会话，并通过 `codex app-server` 启动新的 Codex turn、接收实时输出和处理执行/审批请求。

这个项目的定位是“本机 Codex 操作台”，不是云端 SaaS。它适合在可信网络内使用，用来集中管理多个本地代码项目的 Codex 记录、文件上下文和运行状态。

## 功能

- 本地项目管理：选择或连接项目目录，按用户保存可见项目列表。
- Codex 历史记录：按项目目录的 `cwd` 匹配 Codex threads，支持查看历史记录和继续会话。
- 新建/继续任务：在指定项目目录中启动新的 Codex turn，支持选择模型、推理强度、沙盒和审批策略。
- 实时状态：通过 WebSocket 展示 Codex 输出增量，并在会话列表和会话头部显示 `running` / `idle` 状态。
- 文件上传：把文件上传到当前项目的 `.codex-web/uploads/`，并自动把上传文件路径加入 prompt 上下文。
- 文件预览：支持 Markdown、文本、图片、PDF 和二进制文件信息预览，文本预览最多读取 2 MB。
- 用户视图：内置 `admin` 用户，可创建其他用户来分别记忆项目列表。用户切换只影响本工具里的项目可见性，不隔离 Codex 登录态或系统权限。
- LAN 访问：服务端默认监听 `0.0.0.0:4573`，可以通过环境变量调整监听地址和端口。

## 本分支新增功能

- 会话操作：会话右键菜单支持重命名和复制真实 Codex 会话 ID，便于跨会话继续任务。
- 对话检索：在对话左侧显示当前会话的 prompt 导航与预览，点击可跳转到对应消息；历史分页内容也会按需加载。
- 输入体验：普通 Enter 发送、Shift+Enter 换行；输入法组合输入期间不会误发。焦点不在文本输入控件时，Enter 可发送当前 prompt。
- 消息定位：新发 prompt 会先在底部保留 5 秒，再回到时间线位置；设置保存提示也会随会话推进，不会永久占据底部。
- 多用户隔离：服务端依据经过签名的登录 Cookie 确定用户，忽略伪造的用户 ID，并按用户隔离项目、会话归属、实时消息与 SSH 发送设置。认证默认关闭，部署者可显式启用。
- 远程交付：设置页默认从浏览器来源识别 ZeroTier/SSH 地址，并可将当前用户会话生成的图片、PDF、PPT、Word、表格等文件通过 SSH 发送到其 `~/Downloads`。此功能需要用户保存设置并测试连接后才会启用。
- 界面可用性：排行榜支持独立滚动浏览完整列表；折叠左栏后内容区仍保持可操作。

## 隐私与部署

本分支不包含任何实际会话、上传文件、数据库、部署专用网络地址、私钥、密码或组织信息。认证和跨实例能力均默认关闭或留空，必须由部署者通过环境变量配置；请将这些环境变量和 `.codex-web/` 数据目录保留在部署环境中，不要提交到 Git。

## 技术栈

- 前端：React 19、Vite、lucide-react、react-markdown
- 后端：Fastify、WebSocket、Zod
- 本地存储：`node:sqlite`
- Codex 集成：`codex app-server --listen stdio://`
- 测试：Vitest

## 运行要求

- Node.js 需要支持 `node:sqlite`。本项目当前在 Node.js `v25.6.1` 下验证过。
- npm
- 已安装并登录可用的 Codex CLI
- 需要访问的本地项目目录

可以先确认本机工具：

```bash
node --version
npm --version
codex --version
```

## 快速开始

安装依赖：

```bash
npm install
```

开发模式启动：

```bash
npm run dev
```

开发模式会同时启动：

- Fastify API / WebSocket 服务：本机访问 `http://127.0.0.1:4573`，监听所有网卡
- Vite 前端服务：本机访问 `http://127.0.0.1:5173`，监听所有网卡

Vite 会把 `/api` 和 `/ws` 代理到后端。局域网设备可以访问 `http://<本机局域网 IP>:5173`。

生产构建：

```bash
npm run build
```

运行构建后的服务：

```bash
npm run serve
```

默认访问地址：

```text
http://127.0.0.1:4573
```

服务默认监听所有网卡。同一局域网内的其他设备可以使用本机局域网 IP 访问，例如：

```text
http://192.168.250.102:4573
```

## 常用脚本

```bash
npm run dev                  # 同时启动后端和 Vite 前端
npm run dev:server           # 只启动 Fastify 后端
npm run dev:client           # 只启动 Vite 前端
npm run build                # TypeScript 检查 + Vite 构建
npm run test                 # 运行 Vitest 测试
npm run serve                # 启动后端并托管 dist 前端
npm run generate:codex-schema
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEX_WEB_HOST` | `0.0.0.0` | 后端监听地址 |
| `CODEX_WEB_PORT` | `4573` | 后端监听端口 |
| `CODEX_WEB_PROJECT_ROOT` | `/Volumes/DevDrive/program` | 默认允许浏览和创建项目的根目录 |
| `CODEX_WEB_DATA_DIR` | `.codex-web` | SQLite 数据库和运行数据目录 |
| `CODEX_WEB_CODEX_BIN` | `codex` | Codex CLI 可执行文件 |
| `CODEX_WEB_ALLOW_OUTSIDE_PROJECT_ROOT` | 未开启 | 设为 `1`、`true`、`yes` 或 `on` 后允许连接默认根目录之外的项目 |
| `CODEX_WEB_AUTH_MODE` | `off` | `off` 关闭认证；`member` 只允许已配置用户；`bootstrap` 允许使用下方引导密码创建账号 |
| `CODEX_WEB_AUTH_USER` / `CODEX_WEB_AUTH_PASSWORD` | 未设置 | 可选的初始管理员凭据，仅通过部署环境提供 |
| `CODEX_WEB_DEFAULT_PASSWORD` | 未设置 | `bootstrap` 模式所需的引导密码；请勿写入仓库 |
| `CODEX_WEB_USER_WORKSPACE_ROOT` | `<项目根目录>/users` | 每位登录用户的默认工作区根目录 |

示例：

```bash
CODEX_WEB_PROJECT_ROOT="$HOME/code" \
CODEX_WEB_ALLOW_OUTSIDE_PROJECT_ROOT=true \
npm run dev
```

## 数据位置

- 项目和用户元数据：`.codex-web/codex-web.sqlite`
- 上传文件：当前项目目录下的 `.codex-web/uploads/`
- 前端构建产物：`dist/`

`.gitignore` 已忽略 `node_modules/`、`dist/`、`.codex-web/`、日志和覆盖率文件。

## 工作方式

后端启动时会拉起：

```bash
codex app-server --listen stdio://
```

浏览器不会直接解析 Codex 的隐藏状态文件，而是通过后端桥接到 `codex app-server`：

- `thread/list`：列出项目相关历史会话
- `thread/read`：读取会话详情
- `thread/start`：创建新会话
- `thread/resume`：恢复已有会话
- `turn/start`：启动新的 Codex turn
- `turn/steer`：向运行中的 turn 追加引导
- `turn/interrupt`：中断运行中的 turn
- `command/exec`：执行命令
- `approval.respond`：响应 Codex 发起的审批请求

项目可见性按用户保存在 SQLite 中。会话记录来自 Codex 自身，按 `cwd` 和所选项目目录匹配。

## 文件访问边界

项目目录默认必须位于 `CODEX_WEB_PROJECT_ROOT` 下。如果开启 `CODEX_WEB_ALLOW_OUTSIDE_PROJECT_ROOT=true`，可以连接默认根目录之外的项目。

即使开启越界项目连接，文件预览和上传仍会被限制在当前选中的项目目录内，避免通过文件链接读取项目外部文件。

## 安全说明

- 默认沙盒是 `danger-full-access`，默认审批策略是 `never`。这更适合个人本机可信环境。
- 如果要在不完全可信的项目中使用，建议在界面里切换为 `read-only` 或 `workspace-write`，并把审批策略改为 `on-request`。
- 用户切换不是登录系统，也不隔离 Codex 账号、文件系统权限或系统进程。
- 如果把服务暴露到局域网，请只在可信网络中运行，并确认端口访问范围。

## 测试

运行：

```bash
npm run test
```

当前测试覆盖了：

- Codex RPC envelope 分类和 bridge 行为
- 目录浏览
- 实时运行状态
- 路径边界策略
- 项目/用户 SQLite 存储
- Codex thread fallback 和列表分页

## 项目结构

```text
.
├── server/
│   ├── codexBridge.ts       # codex app-server stdio 桥接
│   ├── config.ts            # 服务配置和默认运行策略
│   ├── db.ts                # SQLite 项目/用户存储
│   ├── directoryBrowser.ts  # 可浏览目录列表
│   ├── index.ts             # Fastify 服务入口
│   ├── liveState.ts         # 实时 turn / agent message 状态
│   ├── pathPolicy.ts        # 项目和文件访问边界
│   ├── routes.ts            # REST API
│   ├── socket.ts            # WebSocket 消息协议
│   ├── threadFallback.ts    # JSONL thread 读取兜底
│   └── threadList.ts        # Codex thread 分页读取
├── src/
│   ├── App.tsx              # 主界面
│   ├── api.ts               # REST API 客户端
│   ├── codexSocket.ts       # WebSocket 客户端
│   ├── styles.css           # UI 样式
│   └── types.ts             # 前端类型
├── tests/                   # Vitest 测试
├── scripts/
│   └── generate-codex-schema.mjs
├── package.json
├── vite.config.ts
└── tsconfig.json
```
