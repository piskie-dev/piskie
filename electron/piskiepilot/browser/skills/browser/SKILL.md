---
name: browser
description: |
  操作和观察真实网页：页面管理、导航、可访问性快照、UID 交互、对话框、文件上传、截图、脚本、控制台与网络。
  适用于网页探索、表单交互和动态内容检查。
---

# Browser

函数签名、参数和返回值以当前工具 schema 为准。

## 页面与观察

- 用 `list_pages` 获取页面 ID；页面工具的 `pageId` 使用返回的 ID。显式指定页面即可操作它，无需先选页。
- `select_page` 改变选中页；需要将标签页带到前台时传 `bringToFront=true`。`new_page` 返回页面列表，用新页的 ID 继续操作。
- 当前结果中的页面信息足够决定下一步时，直接使用。需要新的页面结构或交互目标时用 `take_snapshot`；元素找不到时，获取新快照并重新定位。
- 使用目标页最新快照中的 UID，将 UID 原样传回。持续存在的节点可在新快照中保留 UID；节点替换或从快照中消失后，应以最新观察为准。
- 已知字段和值时优先 `fill_form`。已知后续参数，且无需读取前一步结果或确认成功后才能继续时，可以在同一响应给出多个调用。需要读菜单选项、新页面 ID 或处理失败分支时，先读取当前结果。

## 动作与后续判断

- `click`、`hover`、`fill`、`fill_form`、`drag`、`upload_file`、`press_key` 默认只返回动作结果。需要据页面变化决定下一步时传 `includeSnapshot=true`；结果已有快照时直接使用。
- `type_text` 输入到已聚焦的元素，可用 `submitKey` 随后按键；它不返回快照。需要核对输入或提交效果时另行观察。
- 已知目标文本时用 `wait_for` 传非空文本数组，任一文本出现后返回新快照。动作成功文字不代表业务保存或提交已经完成，按任务要求验证结果。
- 出现 dialog 时，用 `handle_dialog` 接受或拒绝，再观察实际状态。填写中断后核对已填写字段，再决定后续填写。
- 动作报错时可能已产生页面效果。无法确认效果时，先观察实际状态，再决定是否补做。

## 文件、脚本与调试

- `upload_file.filePaths` 可上传多个文件，路径须位于工作区或任务临时目录，且浏览器实例可访问。
- `take_snapshot`、`take_screenshot`、`evaluate_script` 可用 `filePath` 保存结果。相对路径按工作区解析，输出须位于工作区或任务临时目录；使用结果返回的实际文件路径。
- 可访问性快照不足以判断布局、图表、画布或视觉状态时用 `take_screenshot`。默认截图为视口 PNG；元素 `uid` 与 `fullPage=true` 不能同用。结果可能附图像，也可能返回文件路径。
- 用 `evaluate_script` 执行函数声明，支持 async/Promise；返回值须可 JSON 序列化。`args` 传元素 UID，所有元素须属于同一 frame。读取数据时可用 `waitForStableDom=false`；执行会改变页面的脚本后核实实际效果。
- 用 `list_console_messages` / `get_console_message` 检查日志、错误和 issue，用 `list_network_requests` / `get_network_request` 检查请求及响应。需要缩小观察量时按类型筛选或分页，必要时读取详情。
- 列表默认读取当前导航的记录，可用对应 `includePreserved*` 读取保留记录。控制台可请求堆栈或指定 `serviceWorkerId`。
- 网络详情的 `reqid` 可省略以读取 DevTools Network 面板选中请求；无选中时先查列表。用 `requestFilePath` / `responseFilePath` 保存正文；未保存的内联正文可能截断或不可用。
