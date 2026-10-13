# 操作参数

所有请求使用 `feishu_office`：`{action, operation, args, summary?}`。

读取用 `action=read`，写入用 `action=propose` 并提供中文摘要。ID 必须从实际链接或工具结果得到，不能猜测。

| operation | args |
| --- | --- |
| wiki_node | token（/wiki/ 后的节点标识）, obj_type?（默认wiki）；先解析 obj_type 与 obj_token，docx 类型再用 document_info / document_read，不能把 wiki 节点当文档 ID |
| document_info / document_read | document_id |
| document_blocks | document_id, page_size?, page_token? |
| document_create | title, folder_token? |
| document_append | document_id, block_id?（默认根块）, children（飞书 block 数组，最多50个）, index?（默认-1末尾） |
| document_update | document_id, block_id, document_revision_id（先查document_info）, update（飞书patch块请求） |
| chats_list | page_size?, page_token? |
| chat_messages | chat_id, start_time?, end_time?（Unix秒字符串）, page_size?, page_token? |
| message_send | receive_id_type=chat_id, receive_id, text, request_id（唯一UUID）；以应用机器人发群消息，必须用户确认，且群同时对本人和机器人可访问 |
| meeting_transcript | minute_token |
| calendar_list | page_size?, page_token? |
| events_list | calendar_id, page_size?, page_token? |
| approvals_list | topic?（1待办、2已办、3已发起、17未读知会、18已读知会）, page_size?, page_token?；本人ID由服务端绑定，不可传其他用户 |
| approval_definitions | keyword?（如请假）, page_size?, page_token?；仅列本人可发起流程 |
| approval_definition | approval_code；读取真实控件与节点 |
| approval_instance | instance_code；仅本人令牌允许访问的详情 |
| approval_approve / approval_reject | instance_code, task_id, comment?（最多500字符）；同意时可带 form?（实际节点要求的控件数组），必须确认 |
| approval_initiate | approval_code, form（实际表单控件数组）, request_id（唯一UUID）, node_approver_list?, node_cc_list?（数组，每项 key 为真实节点标识，value 为已核实 open_id 数组）；必须确认 |
| attendance_records | check_date_from, check_date_to（有效 yyyyMMdd 数字）, need_overtime_result?；服务器向飞书核实本人企业用户 ID，不接受传入别人的员工 ID |
| reports_list | commit_start_time, commit_end_time（Unix秒数字）, rule_id?；只读本人发起及收到的原生汇报，不等于提交汇报 |

纯文本段落 block 示例：`{"block_type":2,"text":{"elements":[{"text_run":{"content":"正文"}}]}}`。

群历史与发消息的官方接口要求应用身份，需管理员启用机器人并批准相应权限、加入目标群。服务端先用个人身份核实本人属于该群，再使用应用机器人；不会仅凭机器人全局权限读取任意群。发送时明确说明机器人身份，不冒充本人。

接口资料以飞书官方为准：
- https://github.com/larksuite/lark-openapi-mcp
- https://open.feishu.cn/document/server-docs/docs/docx-v1/document/create
- https://open.feishu.cn/document/server-docs/im-v1/message/list

审批执行使用官方本人 user access token 接口（tasks/pass、tasks/refuse、instances/initiate），不会用租户管理员身份代发。请假是企业已有审批流程，不是直接改写假勤记录。应用开通权限后，每个用户仍须重新授权新增范围；接口成功前不能声称已可办理业务。

目前没有通用文件上传、直接改写考勤、原生日报提交或内部豆包直连接口；不要使用任意URL或自己构造租户访问代理绕过此目录。
