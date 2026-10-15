# 原生 DOCX 编辑

## 选择编辑方式

优先使用宿主已接入的原生文档 API。SuperDoc、ONLYOFFICE 等只有在实际工具可用时才可调用；不要凭参考文档虚构工具名。SuperDoc 的浏览器导出不会自动保存到服务器工作区。

宿主拥有未保存文档时，把当前文档快照、选区和基础版本交给修改流程。在独立副本上生成候选，再由宿主应用修订/接受结果。不得让外部文件修改与浏览器中的未保存状态互相覆盖。

没有宿主 API 时，可以对用户指定文件用已安装的 OOXML 感知库处理副本。先确认库对相关结构的支持，不能把 `paragraph.text = ...` 或整篇重建当作保留格式的方法：它会丢失段落内部样式、链接、字段或公式等结构。

## 局部修改

核对原始选区文字、段落位置和基础版本，在准确范围修改。范围跨多个 run、链接、公式或域时使用文档结构操作，保留不相关节点和关系。重复文本的全局搜索替换不等于选区编辑。

保持未被授权更改的段落样式、编号、表格、图片、页眉页脚、脚注、批注、修订和公式。对不支持的结构保留原内容并说明限制，不静默剥除。公式可编辑性需检查 OMML；看起来像公式的图片不等于可编辑公式。

修订请求使用原生修订 API；不要通过红字、删除线或两份纯文本差异冒充 Word 跟踪修订。用户未要求修订时不强制新增批注或改变已有修订状态。

## 检查和保存

对修改前后文件运行 `scripts/inspect_docx.py`，检查可解析性、公式/图形/表格等计数差异以及警示。该脚本不能证明所有 OOXML 特性受编辑器支持，也不替代视觉或内容检查。

必要时用已有 Word/Office 渲染路径导出 PDF 并查看相关页面；不同字体和渲染器可能改变分页。编辑器预览正常不意味着 Word 打开后一模一样。

检查真正保存到工作区的文件，重新打开核对修改。主文件发生版本冲突时保留候选并请求解决，不能用旧内存副本覆盖新文件。普通 `.doc` 不属于 DOCX：需要先转换成独立副本，不能只改扩展名。

参考：

- 选区：[SuperDoc selection.current](https://docs.superdoc.dev/document-api/reference/selection/current/)
- 文档操作：[SuperDoc Document API](https://docs.superdoc.dev/document-api/reference/)
- Office 插件：[ONLYOFFICE document API](https://api.onlyoffice.com/docs/plugins/interacting-with-editors/document-api/Methods/)
