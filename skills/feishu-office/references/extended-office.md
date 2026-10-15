# 扩展办公参数

读取用 `feishu_office({action:"read",operation,args})`。下表“确认”操作用 `action:"propose"` 和准确中文 `summary`，等待用户在飞书办公窗口批准；不能自行调用确认接口。参数 ID 从实际资源、链接解析或读取结果取得，不能手填他人身份。

## 云盘与文件

| operation | args | 确认 |
| --- | --- | --- |
| drive_files_list | folder_token?，page_size≤200，page_token?，order_by=EditedTime/CreatedTime，direction=ASC/DESC；根目录无分页 | 否 |
| drive_files_metadata | request_docs:[{doc_token,doc_type}]≤200，with_url? | 否 |
| drive_folder_create | name（≤256 UTF8字节），folder_token（根目录可空字符串） | 是 |
| drive_file_copy | file_token，folder_token，name，type:file/doc/sheet/bitable/docx/mindnote/slides | 是 |
| drive_export_create | token，type:doc/docx/sheet/bitable，file_extension:docx/pdf/xlsx/csv，sub_id? | 否：不修改原文档的派生导出 |
| drive_export_get | ticket，原资源token | 否 |
| drive_file_download | file_token，filename? | 否 |
| drive_export_download | 导出结果的file_token，filename? | 否 |

doc/docx 导出 docx/pdf，sheet/bitable 导出 xlsx/csv；CSV 必须指定 sub_id，其他格式不传 sub_id。知识库节点先 `wiki_node` 解析实际 obj_token，不能直接导出 wiki 节点。下载最多25MB，返回 `download_url`、字节数和24小时有效期，需同一登录用户打开；每人临时缓存最多20份／100MB，不返回凭据。普通文件下载与导出产物下载是不同操作。

`drive_export_get` 的 `data.result.job_status`：0成功，1初始化，2处理中，其余为失败，读取job_error_msg解释原因。仅0且有file_token后下载；不能拿到ticket就声称完成。轮询须有界，处理中可稍后继续查，不重建重复导出任务。成功下载非空产物后才报告可下载；没有客户端证据时不说已保存到用户电脑。

## 电子表格

| operation | args | 确认 |
| --- | --- | --- |
| spreadsheet_create | title，folder_token? | 是 |
| spreadsheet_info / spreadsheet_sheets_list | spreadsheet_token | 否 |
| spreadsheet_sheet_create | spreadsheet_token，title，index? | 是 |
| spreadsheet_range_read | spreadsheet_token，range，value_render_option?，date_time_render_option? | 否 |
| spreadsheet_ranges_read | spreadsheet_token，ranges:[range]≤20，同上渲染选项 | 否 |
| spreadsheet_range_update | spreadsheet_token，range，values二维数组 | 是 |
| spreadsheet_range_append | 同上，insert_data_option=INSERT_ROWS（默认）或OVERWRITE | 是 |

range 是 `sheet_id!A1:B2`，显式限定最多5000行100列，不能用工作表名称、整列或无界范围。单元格仅字符串、有限数字、布尔或null；数据行宽一致且落在范围内，≤8MiB。读取格式可 ToString/Formula/FormattedValue/UnformattedValue，日期格式可 FormattedString。读取公式和现有格式后再修改，不能保证重写富文本／公式后“格式完全无损”。追加默认插入新行；覆盖须用户明确要求。

## 多维表格

| operation | args | 确认 |
| --- | --- | --- |
| bitable_app_create | name，folder_token?，time_zone? | 是 |
| bitable_table_create | app_token，table:{name,default_view_name?,fields?:字段定义[]} | 是 |
| bitable_table_update | app_token，table_id，name | 是 |
| bitable_field_create / bitable_field_update | app_token，table_id，field_name，type，property?，description?；update还需field_id | 是 |
| bitable_views_list / bitable_view_get | app_token，table_id；list分页≤100；get需view_id | 否 |
| bitable_view_create | app_token，table_id，view_name，view_type:grid/kanban/gallery/gantt/form | 是 |
| bitable_view_update | app_token，table_id，view_id，view_name?，property?:{hidden_fields?:field_id[],filter_info?:{conjunction,conditions:[{field_id,operator,value?:string}]}} | 是 |
| bitable_app_info / bitable_tables_list | app_token，list可page_size≤100/page_token | 否 |
| bitable_fields_list | app_token，table_id，view_id?，分页≤100 | 否 |
| bitable_records_search | app_token，table_id，view_id?/field_names?/sort?/filter?/automatic_fields?，分页≤500 | 否 |
| bitable_record_create | app_token，table_id，fields | 是 |
| bitable_record_update | 同上，record_id | 是 |
| bitable_records_batch_create / bitable_records_batch_update | app_token，table_id，records≤1000；每条fields，update还需record_id | 是 |

先读取字段定义确定字段名和类型。filter:{conjunction:"and"/"or",conditions:[{field_name,operator,value?:string[]}],children?:同结构条件组[]}。sort:[{field_name,desc?}]。fields 允许文本／数字／布尔、超链接{text?,link}、地点对象、字符串数组、人员[{id}]、附件[{file_token}]，不接收任意API JSON。若某种字段格式当前不支持，说明限制，不把未知对象硬塞进写入参数。

字段定义支持 `field_name,type,property?,description?`；类型：1文本、2数字、3单选、4多选、5日期、7复选框、11人员、13电话、15超链接、17附件、18单向关联、21双向关联。property支持 `options:[{name,id?,color?}]`、`formatter`、`date_formatter`、`auto_fill`、`multiple`、`table_id`、`back_field_name`；description为 `{text,disable_sync?}`。先读现有结构，优先新增而不是转换已有字段；修改选择项必须保留现有选项 ID，类型转换可能影响原数据，预览中明确警告。不支持的复杂字段属性不能作为任意JSON绕过。

能新建 Base、数据表、字段与视图，不需要用户先手工导入 Excel。但视图创建不等于完成前端所有布局配置：当前公开视图创建接口只接收名称和类型，甘特起止绑定、看板分组等未开放参数不假称已配置；可以先生成正确日期／状态字段与记录，再说明需界面补设的部分。不自动邀请成员或扩大资源共享权限。

## 本人任务

| operation | args | 确认 |
| --- | --- | --- |
| tasks_list | completed?，分页≤100；固定本人my_tasks | 否 |
| task_get | task_guid | 否 |
| task_create | summary，description?/start?/due?/completed_at?/client_token?/assignee_open_ids? | 是 |
| task_update | task_guid，task:{summary?/description?/start?/due?/completed_at?} | 是 |
| task_add_assignees | task_guid，assignee_open_ids:[ou_*]≤50，client_token?；仅添加不移除原负责人 | 是 |
| tasklists_list | 分页≤100 | 否 |
| tasklist_create | name | 是 |
| task_comments_list | task_guid，direction=asc/desc，分页≤100 | 否 |
| task_comment_create | task_guid，content，reply_to_comment_id? | 是 |

start/due:{timestamp:"毫秒数字字符串",is_all_day?}；完成用真实毫秒时间，恢复用 completed_at:"0"。client_token 用唯一标识避免重复创建。不支持直接替换／移除负责人或修改清单共享成员，不用添加新人冒称已替换旧负责人。没有任务通知开关，不能保证完成任务不触发飞书原生通知；用户要求绝不通知时先核实，不猜造need_notification。飞书任务不等于本网页会话定时唤醒，也不等于持续目标。

## 日程与文档评论

| operation | args | 确认 |
| --- | --- | --- |
| calendar_event_get | calendar_id，event_id，need_attendee?/max_attendee_num? | 否 |
| calendar_event_create | calendar_id，UUID idempotency_key，start_time，end_time，summary?/description? | 是 |
| calendar_event_update | calendar_id，event_id，至少一个修改字段；修改时间须同时给起止 | 是 |
| calendar_attendees_list | calendar_id，event_id，分页10–100 | 否 |
| calendar_attendees_create | calendar_id，event_id，attendees，need_notification? | 是 |
| calendar_freebusy | RFC3339 time_min/time_max，跨度≤90天；不传user_id/room_id | 否 |
| document_comments_list | file_token，file_type=docx/doc，is_whole?/is_solved?，分页≤100 | 否 |
| document_comments_create | file_token，file_type，reply_elements:[{type:"text",text}]；可mention_user/link | 是 |
| document_comment_replies_list | file_token，comment_id，file_type，分页≤100 | 否 |
| document_comment_replies_create | file_token，comment_id，file_type，content:{elements:[{type:"text_run",text_run:{text}}]} | 是 |
| document_comment_resolve | file_token，comment_id，file_type；固定标记解决 | 是 |

日程 start_time/end_time 各用 {timestamp:"Unix秒",timezone?} 或 {date:"yyyy-MM-dd"}，不能混用，结束晚于开始。忙闲始终由服务端绑定本人身份。参与人可用户{type:"user",user_id:"ou_*"}、群{type:"chat",chat_id}、外部邮箱{type:"third_party",third_party_email}、会议室{type:"resource",room_id,approval_reason?}；添加参与人会发邀请，须明确列出目标并确认。

以上全部用本人 user_access_token。授权范围覆盖操作不代表可访问所有文档、群、表格或任务；服务端和飞书资源ACL继续限制实际目标。遇到无权限，不借用租户管理员身份或公开共享资源来绕过。
