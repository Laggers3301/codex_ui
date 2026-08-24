# Codex 4575 账号池测试版运维说明

## 当前边界

- 生产 `4573/4574` 未改动，继续作为回退入口。
- 测试前端监听 `0.0.0.0:4575`，只反代本机 `127.0.0.1:4576`。
- 测试后端和两个 `codex app-server` 只监听本机，不直接暴露到网络。
- 账号配置隔离在：
  - `/home/ls/codex_zerotier_remote/runtime/account-pool/260803`
  - `/home/ls/codex_zerotier_remote/runtime/account-pool/260707`

## 推荐访问顺序

1. Tailscale 稳定名称：`https://codex-pool.tail6856d9.ts.net/`（Tailnet 开启 Serve 后生效）。
2. Tailscale IP：`http://100.73.43.120:4575/`。
3. ZeroTier 回退：`http://10.244.0.143:4575/`。
4. 公司同一局域网：`http://192.168.50.78:4575/`。

Tailscale 已从另一台物理机验证为局域网直连，不经过 DERP；首次连接建链后，重复 HTTP 请求约 4–10ms。不要在验证期移除 ZeroTier。

不要只以“客户端显示在线”判断性能。客户端执行 `tailscale ping codex-pool` 时应显示 `via <ip>:<port>`；如果持续显示 `via DERP(...)`，访问虽然可用，但延迟取决于中继。再执行 `tailscale netcheck`，确认 `UDP: true`，并检查本机防火墙、公司网络或热点是否拦截 UDP。服务端当前监听 UDP 41641，2026-08-24 自检为 `UDP: true`、公网 IPv4 可用且 NAT 映射稳定。

服务端的可重复直连门槛：

```bash
CODEX_TAILSCALE_TARGET=<客户端 Tailscale IP 或 DNS 名> \
./scripts/tailscale-path-smoke.mjs
```

只要所有样本仍为 DERP，脚本就返回失败；至少出现一个 `via IP:端口` 的 direct 样本才通过。

如果门槛持续失败，必须在客户端或其出口网络处理：

1. Windows 执行 `tailscale netcheck`，确认 `UDP: true`；执行 `tailscale ping codex-pool` 观察路径。
2. 防火墙允许 Tailscale 发起 UDP：默认从 `41641` 到任意目标，并允许到任意 STUN 服务器的 UDP `3478`。不同客户端端口配置以本机实际值为准。
3. 暂停 ZeroTier、其他 VPN 或企业安全代理后复测；再切换手机热点复测，用来区分 Windows 防火墙与公司出口网络。
4. 如果公司网络无法放行 UDP，需增加第三台低延迟、具有稳定公网 UDP 端点的 Tailnet 设备作为 peer relay，并在 Tailnet policy 中授予 `tailscale.com/cap/relay`。当前服务端不能作为“连接到它自己”的第三方 relay。
5. 自建 DERP 是最后选择；Tailscale 官方在经常被 DERP 中继且性能不足时优先建议 peer relay。

官方依据：

- https://tailscale.com/docs/reference/faq/firewall-ports
- https://tailscale.com/docs/features/peer-relay
- https://tailscale.com/docs/reference/derp-servers
- https://tailscale.com/docs/reference/troubleshooting/network-configuration/derp-routing

电脑和手机都必须安装 Tailscale、使用受邀账号加入同一个 Tailnet，并在访问期间保持 Tailscale VPN 开启。Tailnet-only 的 Serve 地址不会因设备曾经连接过一次就永久变成公网地址。成员应逐人邀请，不要共享同一个 Tailscale 登录账号；网页登录仍是独立的第二层认证。

## 服务控制

```bash
systemctl --user status codex-account-pool-4576.service
systemctl --user status codex-account-pool-ui-4575.service
systemctl --user restart codex-account-pool-4576.service
systemctl --user restart codex-account-pool-ui-4575.service
```

系统级 Tailscale：

```bash
systemctl status tailscaled
tailscale set --accept-dns=true
tailscale serve --bg http://127.0.0.1:4575
tailscale status
tailscale ping <客户端 Tailscale IP>
tailscale serve status
```

Tailnet 管理端需逐人邀请成员，并在 ACL/grants 中允许这些成员访问 `codex-pool:443`。如果使用默认全允许策略则无需另加规则；收紧 ACL 后必须重新验证手机和电脑端。

## 账号调度规则

- 新会话选主额度剩余比例最高的健康账号。
- 剩余额度相同才比较账号健康状态和已分配会话数。
- 会话创建后固定到原账号，恢复/继续对话不会跨账号，因此不会因为均衡调度丢失账号侧上下文或缓存命中。
- 额度查询并行执行并缓存 30 秒；冷查询不阻塞正常会话历史渲染。
- 路由状态持久化在 `data/account-pool-state.json`。

## 已迁移会话

- `260707` 的 489 个会话文件（488 个 JSONL 和 1 个历史备份，约 3.3GB）已复制到隔离账号目录。
- 477 条状态库路径已改写到新目录。
- 源前端 246 条明确权属记录已导入到 20 个用户。
- 每个用户使用独立项目 `codex1 迁移会话`，根目录为 `/home/ls/codex_zerotier_remote/users/<用户>/codex1-migrated`。
- 170 条源端可见记录继续可见；76 条源端已删除记录保持隐藏，没有误恢复。
- 旧别名合并到当前登录名：`jiaming→wjm`、`jiangyuhua→jyh`、`wangxuran→wxr`、`wuming→wm`、`xujiayu/x'j'y→xjy`。

当前 `260803` 生产会话另做隔离镜像：

- 311 个当前 JSONL 同步到 `runtime/account-pool/260803/sessions`。
- 151 条当前权属记录保持原用户、原工作区。
- 与 codex1 重叠的 49 条记录使用确定性新 thread ID；旧 ID/旧快照留在 `codex1 迁移会话`，当前副本留在原工作区。
- 所有项目均按 `project_id` 严格隔离；“我的工作区”不再汇总同一用户其他项目，因此不会混入 `codex1 迁移会话`。
- 同一用户历史遗留的同名 `codex1 迁移会话` 会归并到唯一的 `<用户>/codex1-migrated` 项目，避免前端出现多个同名入口。
- `codex-260803-live-sync.timer` 每 15 秒增量同步新增会话和追加内容。
- 如果检测到某条目标会话已经在 4575 被继续编辑，该条会自动停止被源端覆盖，防止双写破坏历史。
- 共享 `web.sqlite` 使用 WAL、5 秒 busy timeout 和 NORMAL 同步级别，避免 15 秒同步任务与网页高并发读取互相制造 `database is locked`。
- 线程事件索引在 JSONL 解析完成后才分批开启短事务；索引 WAL 可在空闲时用 `PRAGMA wal_checkpoint(TRUNCATE)` 回收，不要删除 sqlite、wal 或 shm 文件。

迁移备份位置记录在 `data/latest-migration-backup-path`。源 `.10` 主机与源会话未删除。

## 验证清单

```bash
npm run build --prefix frontend
npm run build --prefix backend
curl -I http://127.0.0.1:4575/
curl -I http://10.244.0.143:4575/
```

浏览器必须再验证：

1. 登录后额度弹窗同时显示 `260803` 和 `260707`，两者健康状态为 `ready`。
2. `gyj` 只有一个 `codex1 迁移会话` 项目，当前显示 9 条可见记录（7 条 260707 导入记录和 2 条此前已迁移记录），并且正文可打开；“我的工作区”与它的 thread ID 交集必须为 0。
3. `jpy` 的同名独立项目显示 22 条可见记录，且看不到 `gyj` 的项目。
4. 创建一条新会话，确认当前选择剩余比例更高的账号；刷新/重启后继续同一会话仍落在同一账号。

## 压力测试

默认脚本不会输出密码或会话 cookie。已登录的本机 Firefox 可复用 WebDriver 会话；普通运维环境应通过临时环境变量传密码，不要把密码写进脚本或日志。

```bash
cd /home/ls/codex_zerotier_remote/users/gyj/account-pool-4575
CODEX_STRESS_BASE_URL=https://codex-pool.tail6856d9.ts.net \
CODEX_STRESS_USER=<用户> \
CODEX_STRESS_PASSWORD=<临时输入> \
CODEX_STRESS_SEQUENTIAL=20 \
CODEX_STRESS_BURST=120 \
CODEX_STRESS_CONCURRENCY=24 \
./scripts/stress-smoke.sh
```

脚本覆盖项目发现、额度缓存、每个工作区的会话列表与正文读取，并以非 2xx、网络异常或 JSON 异常作为失败。详细结果见 `STRESS_REPORT_2026-08-24.md`。

额度冷刷新与普通列表互不阻塞的专用回归：

```bash
CODEX_QUOTA_BASE_URL=https://codex-pool.tail6856d9.ts.net \
CODEX_WEBDRIVER_SESSION=<已登录的测试浏览器会话> \
./scripts/quota-refresh-smoke.mjs
```

脚本会为 Tailnet 私有域名自动绕过主机 HTTP 代理，不打印 cookie。账号选择纯函数的确定性回归使用：

```bash
npm test --prefix backend -- --run server/accountPoolBridge.test.ts
```

## 上线步骤

1. 保持 `4573/4574` 不变，先让内部用户使用 4575 和 Tailscale 入口观察 24–48 小时。
2. 观察后端服务重启次数、账号 `ready` 状态、冷/热额度刷新延迟和大对话加载时间。
3. 确认所有常用用户的 `codex1 迁移会话` 数量正确。
4. 稳定后把公司书签/内部说明切到 Tailscale DNS 名；ZeroTier 地址继续保留至少一周。
5. 如需公网浏览器入口，使用现有域名创建命名 Cloudflare Tunnel 指向 `http://127.0.0.1:4575`；不要把 Quick Tunnel URL 当长期入口。

## 回滚

账号/会话迁移一键回滚（只影响 4575 测试版）：

```bash
/home/ls/codex_zerotier_remote/users/gyj/account-pool-4575/scripts/rollback-260707-migration.sh
```

脚本会先停 4576，把当前状态完整移到新的 `rollback-capture-*` 目录，再恢复迁移前账号目录、测试数据库和路由表，最后重启服务。它不会修改 4573/4574，也不会删除迁移后的捕获副本。

只撤销当前 `260803` 镜像和实时同步、保留 260707/codex1：

```bash
/home/ls/codex_zerotier_remote/users/gyj/account-pool-4575/scripts/rollback-260803-sync.sh
```

网络回滚：停止使用 Tailscale URL 即可；ZeroTier 和生产 Cloudflare 入口始终保留。需要清除测试 Serve 时执行：

```bash
tailscale serve reset
```

如果还要恢复本机原有 DNS 行为，再执行：

```bash
tailscale set --accept-dns=false
```
