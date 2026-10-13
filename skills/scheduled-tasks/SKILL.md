---
name: scheduled-tasks
description: 在 Codex Web 中通过自然语言创建、查看、修改、暂停、恢复或删除会话定时任务；适用于提醒、预约执行、周期检查和修改现有计划。不是持续目标、系统 cron 或外部日历管理。
---

# 会话定时任务

用户要求“明天执行”“每天检查”“暂停那个计划”“把时间改为……”时，自动采用此技能，无需用户输入 `$scheduled-tasks`。

使用 `codex_schedules` MCP 的 `scheduled_tasks` 工具。它管理号池右栏的同一套持久化任务，不是 OpenAI 桌面 App 的私有存储。不要直接编辑 JSON、使用 cron，或用 shell 的 sleep 代替调度器；工具不可用时如实说明，不能假称已预约。

## 确定目标

- 创建默认绑定当前会话；明确指定其他会话时，用 `list` 的 `scope: user` 查看本人已有任务，结合任务标题、projectName、threadId 确认目标。修改其他会话用准确 taskId，不需要先打开或切换那个会话。
- 查询当前任务用 `action: list`；查询本人全部任务用 `action: list, scope: user`。没有匹配任务、重名或目标不明确时只澄清缺失的信息，不猜测、不批量修改。
- 创建目标为尚无任务的其他会话时，必须先获得已确认的会话 ID；工具不会凭一个名字新建会话。

## 时间与操作

- `list` 返回服务器 `now` 和默认时区 `Asia/Shanghai`。将相对日期按这个当前时间及用户时区转成具体时间；用户指定的时区优先。
- 单次：`schedule: {kind: once, at: "2030-01-02T09:00:00+08:00", timezone: "Asia/Shanghai"}`。实际时间必须在未来。
- 周期：interval 的 intervalMinutes 至少 5；daily / weekdays 使用当地 `time: HH:mm`；weekly 还需 weekdays（0 周日，1 周一，…，6 周六）。目前不支持任意 cron、月度或事件触发，不能静默改成每日。
- `create` 必须有 prompt 与 schedule。prompt 写每次唤醒要执行的具体任务、必要的路径、输出要求和停止条件，不只写“提醒一下”。默认 enabled 为 true；用户只要草稿时创建 enabled=false。
- `update` 仅传用户要改变的 title、prompt、schedule、enabled，保留其他字段。暂停用 pause，继续用 resume；已过期或执行过的单次任务必须给出新的未来 schedule 才能继续。
- 删除仅在用户明确要求后用 delete 和 confirm=true。暂停/删除不会终止正在运行的模型，也不会撤回已入队的消息；工具有 warning 时告知用户。

## 验证与反馈

仅以工具成功返回为已保存；读取返回的 id、enabled、nextRunAt 和目标 threadId，必要时 get 回读。若新建结果不确定，先 list 确认，避免重复创建。

用简体中文简洁确认“做什么、何时、时区、哪个会话、是否启用”；工具报错要解释，不能说“已设置”后留下空任务。定时任务按目标会话原有模型、权限与上下文执行，主机和后端必须在线；暂停未来调度不等于停止当前回答。
