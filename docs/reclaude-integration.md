# ReClaude 接入

未配置时不会启动 Claude 运行时，也不会修改 GPT、Ark、MiMo 的账号或凭据。

## 授权与账号风险

- 接口兼容、能发出请求，不代表第三方客户端及账号来源已获 Anthropic 授权。本文不为 ReClaude 的运营方、账号或客户端背书；开通前核实来源与允许的使用范围。
- 官方帮助中心目前说明：通过 Agent SDK、`claude -p` 使用个人订阅仍计入订阅额度。这不等于允许把个人订阅集中转供多人使用；法律与合规文档另有第三方服务、凭据中介限制。团队部署优先评估符合地区和主体要求的官方 API／企业授权。
- 官方将不支持地区、条款违规列为停用账号的原因。固定代理、住宅 IP 或购买 VPS 均不改变实际使用地区、主体和授权范围，也不是防封保证。
- 登录、KYC 或封禁异常交由官方流程处理；不通过清痕、伪造设备或自动换号绕过。401／403 与额度耗尽不盲目重试；429 依据具体额度、重置时间或限频状态处理。
- 不自动执行“干净重装”命令。Claude 网页聊天与 Claude Code 的本地历史不是同一份存储；删除 `.claude`、`.claude.json`、系统凭据或全设备退出会破坏本地历史、MCP／项目设置或登录态。正常运维保留它们，也不把代理变量、凭据或完整配置输出到日志。

官方依据（核对于 2026-11-05）：[订阅与 Agent SDK](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)、[认证与凭据使用限制](https://code.claude.com/docs/en/legal-and-compliance)、[停用与申诉](https://support.claude.com/en/articles/8241253-safeguards-warnings-and-appeals)、[支持地区](https://www.anthropic.com/supported-countries)。

## 部署

1. 在应用目录运行 `npm run setup:claude`，安装隔离的会话工具依赖。它不替换现有 SDK。
2. 使用已授权的 ReClaude 客户端完成登录。网页不接受、保存或代填账号密钥。
3. 在仓库外创建权限为 `0600` 的配置文件，例如：

```json
{
  "home": "/srv/reclaude",
  "executable": "/usr/local/bin/reclaude",
  "storageDirectory": "/srv/codex-private/claude",
  "users": {
    "example-user": {
      "workspaceRoot": "/srv/workspaces/example-user",
      "orgIds": ["1234"]
    }
  }
}
```

路径和组织编号均为示例。`home` 下应有客户端自己的 `.rec/claude/accounts`；`executable` 必须是管理员确认的客户端入口。通过 `CODEX_WEB_CLAUDE_CONFIG` 指定此文件，再按现有发布流程重载后端。配置、登录目录和运行数据库不得提交 Git。

管理员可在同一私有配置中加入 `sharedUsers`，授权已登录的号池用户共用指定绑定：

```json
{
  "workspaceDirectory": "/srv/workspaces",
  "orgIds": ["1234"]
}
```

上述对象是 `sharedUsers` 的值。每位用户只能使用该目录下与登录 ID 同名的现有独立目录；路径穿越、缺失目录和指向其他用户目录的软链接不获得共享授权。`users` 中的显式配置优先。共享的是 Claude 账号和额度，不合并用户工作区、会话或权限。

额度栏先显示 GPT 账号，再显示 ReClaude 和 Ark。MiMo 仅隐藏额度入口，模型仍可选择。正常用量不重复展示说明文字；额度耗尽和读取错误仍显示。

## 行为

- 回答下方的分支入口可指定 GPT 账号或 ReClaude 模型；同引擎沿用原生分支，跨引擎仅导入截至所选回答的可见历史，工具记录不重放。原会话和权限设置保留。
- 推理档位读取原生客户端的 `supportsEffort` / `supportedEffortLevels`，通过 Agent SDK 的 `effort` 传入。旧模型未声明能力时不虚构档位。GPT 分支档位同时写入原生配置与会话元数据。
- 全局弹窗统一字体、遮罩模糊及进出动效；面板背景复用右栏 `--bg` 主题变量。编辑器内容不作为界面文字重排。

- 模型目录后台更新，菜单先返回缓存；尚未核实版本时明确标注。
- Claude 新建、分支和迁入共用滚动一小时五次的本地账本；GPT 新建和已有会话续聊不计入。
- 额度来自原生响应事件或管理员提供的本地缓存；没有数据时显示未知，不伪造百分比，不额外轮询 OAuth 用量接口。
- 历史分页同时限制条数和 8MiB 字节预算。单轮超大记录返回明确错误，原始记录不截改。
- 普通续聊不反复复制整份历史；显式分支、迁移保留源快照。跨引擎迁移保留可见文字和工具结果，不把历史工具操作重新执行。
- 工具审批和提问按用户、会话隔离。关闭服务后忽略晚到回调，不重复发起模型请求。

## 验证范围

`server/claude*.test.ts`、`server/runtimeHistoryTransfer.test.ts`、`server/reclaudeUsage.test.ts` 使用临时账号夹具。`node tests/reclaude.playwright.mjs` 验证桌面和手机菜单、流式显示、审批与刷新去重，不调用真实模型。实际账号的连通性仍需部署者在完成授权后验证。
