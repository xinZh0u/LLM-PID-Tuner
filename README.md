# LLM_Tuner

LLM_Tuner 下位机的网页版上位机：多分页串口波形 + 参数调参 + 智能体 + 源码读写。

- 串口：Web Serial（Chrome / Edge），协议与 [`llm_tuner.c`](../26_tunnel_sentry/LLM_Tuner/stm32/llm_tuner.c) 完全一致
- 多分页：每个分页一套 VOFA 式布局（左串口栏 / 中波形+控制台 / 右参数栏），三个面板都能拖动改大小、都能隐藏
- 多个分页共享同一条串口数据流（底层只解析一次，各页各自显示）
- 数据格式：`LLM_Tuner`（DESC / ARG / TUNNING / TRANS_SET，CRC16）与 `RAW`（原样显示）
- 工程面板：直接读源码里的 `tuner_add_arg(...)`，把调好的值写回变量初始化处（带 diff 预览）
- 智能体：OpenAI 兼容接口 + 工具调用，可读参数、取采样、调参、读源码
- 主题：默认跟随 VS Code（扩展里）/ 系统（浏览器里），也可手动锁定浅色或深色
- VS Code 扩展：左侧活动栏图标，一键在内置浏览器里打开面板

## 启动

**方式 A：VS Code 扩展（推荐）**

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-vsix.ps1
code --install-extension .\llm-tuner-0.1.0.vsix
```

重载窗口后点左侧 **LLM_Tuner** 图标即可。扩展自带本地服务并托管网页，不需要另外起服务。

**方式 B：直接起本地服务**（需要 Chromium 内核浏览器）

```powershell
# 不依赖任何运行时（Windows 自带 PowerShell）
powershell -ExecutionPolicy Bypass -File .\scripts\serve.ps1 -Port 5173

# 有 Node.js
npm start

# 有 Python
python -m http.server 5173
```

然后浏览器打开 <http://localhost:5173>。

> 端口下拉里选 **模拟数据源（无需硬件）** 可以先看完整效果：它会用与下位机一致的帧格式产生 8 个参数，
> 并且会响应调参包和传输位图，等于一个虚拟下位机。

## 目录

```
index.html            页面骨架
styles.css            全部样式
src/main.js           启动、分页管理、持久化
src/core/crc16.js     CRC-16/MCRF4XX（与 crc.c 的 crc16 表一致）
src/core/tuner.js     帧编解码 + 流式解析器
src/core/ring.js      每通道环形缓冲（默认 50000 点）
src/core/hub.js       全局数据中枢（一份数据 → 所有分页）
src/core/link.js      Web Serial 链路 + 模拟下位机
src/core/conn.js      连接状态机（全局唯一串口）
src/core/srcmap.js    源码扫描 / 初始化值定位 / 写回编辑
src/core/project.js   工程后端（浏览器目录授权 / VS Code 桥接）
src/ui/chart.js       Canvas 波形（自动 Y、抽稀、缩放平移、十字光标）
src/ui/console.js     输入输出控制台（文本 / Hex）
src/ui/page.js        单个分页（布局、分割条、参数表、调参）
src/ui/agent.js       智能体抽屉 + 工具调用
src/ui/projectPanel.js 工程/代码抽屉
vscode-extension/      VS Code 扩展（活动栏图标 + 内置浏览器 + 源码桥接，无 npm 依赖）
  media/icon.svg      活动栏图标
  web/                打包时从仓库根同步的网页资源
scripts/serve.ps1     本地静态服务（PowerShell，零依赖）
scripts/serve.js      本地静态服务（Node）
scripts/package-vsix.ps1 / package-vsix.js  同步网页 + 手工打包 .vsix
scripts/test-extension.js                  扩展的自动化自测（stub vscode）
```

## 数据流

```
串口字节流 ──► Hub（只解析一次）
                 ├─► 参数表 / 环形缓冲 ──► 各分页波形、参数栏
                 └─► 原始字节 ──────────► 各分页控制台
```

因此「不同分页接收同一个串口的数据」是天然成立的，切换分页不会丢数据。

## 协议要点（与下位机实现一致）

| 项 | 值 |
| --- | --- |
| 帧头 | `0x4C54`，小端发送后是 `'T' 'L'` |
| 帧结构 | `header(5) + payload(len) + crc16(2)` |
| CRC | 反射多项式 `0x8408`，初值 `0xFFFF`，低字节在前 |
| DESC (0) | `[类型<<4 \| 属性] 名称 ':' 描述 '\0'` 重复；下位机按索引顺序分批发 |
| ARG (1) | `arg_num` + 位图（bit 7-i%8）+ 选中项各 4 字节 |
| TUNNING (2) | `uint8 index` + `uint32 值`（5 字节，值在小端偏移 1） |
| TRANS_SET (3) | `arg_num` + 位图 |

上位机侧的实现细节：

- 描述包没有索引字段，所以按到达顺序累加；丢包会导致索引错位，面板里会提示「参数表不一致」，此时点「重置参数表」让下位机重发描述。
- 下位机只发带 `TRANS` 属性的参数，因此「勾选要画的参数」= 「让下位机回传这些参数」：程序会把**所有 Tuner 分页勾选的参数取并集**，动态下发 `TRANS_SET`。
- `double` 下位机用 float 精度传输，上位机按 float 解析。

## 波形操作

| 操作 | 效果 |
| --- | --- |
| 左键拖动 | X（时间）+ Y 同时平移；纵向拖动会自动切到手动 Y，并退出「跟随」 |
| 滚轮 | 以光标为锚点缩放，X、Y 同倍 |
| Shift + 滚轮 | 只缩放 X |
| Alt / Ctrl + 滚轮 | 只缩放 Y |
| **双击曲线** | 吸附到最近的采样点选 **A**，再双击选 **B** → 画出两点、竖直虚线、连线，并标注 **Δt**（同一条曲线时再标 **Δy**） |
| 第三下双击 | 清空并重新从 A 开始 |
| Esc | 有测点就清除测点，没有就复位视图 |
| 右键 / 工具栏「复位」 | 恢复跟随 + 自动 Y |
| 工具栏「清除测点」 | 只清 A、B |

Δt 取自两条**实际采样点**的时间戳，所以是真实采样间隔；工具栏会显示一行可复制的 `A→B Δt 1.005 s Δy +0.564`。
测点属于临时测量，不进 localStorage，刷新即清空。

- **暂停**：画面完全冻结（曲线、图例数值都不再变），数据仍在后台接收；点「继续」从最新数据接着画
- **断开连接**：窗口自动钉在最后一批数据上，已采到的波形继续留在画面上，不会滑走变空白
- 右侧参数栏点击某一行：可改显示名、颜色、增益、偏移、小数位，并在「写入值」里回车下发调参包

## 工程与代码（把参数写回源码）

两条路，按需选：

### A. 浏览器目录授权（零安装）

点顶部 **工程** → **选择工程目录**，选到固件目录（例如 `.../LLM_Tuner/stm32`）。浏览器会请求读写权限（只需一次，之后记住）。

- 扫描 `.c/.h/.cpp/.hpp`（自动跳过 `Drivers`、`Middlewares`、`build` 等目录）
- 解析每个 `tuner_add_arg(类型, 属性, "名字", "说明", &变量)` 调用
- 按名字与在线参数表匹配，找出目标变量在源码里的初始化值（支持 `static float kp = 1.2f;`、`{ .kp = 1.2f }`、`#define NAME 1.2f`）
- 勾选后「预览改动」看 diff，再「写回勾选项」把**当前在线值**写回初始化处（保留 `f` 后缀）

### B. VS Code 扩展（推荐，见下文「打包/安装」）

扩展会在左侧活动栏放一个 **LLM_Tuner** 图标，点开即用 VS Code 内置浏览器打开面板，并且：

- 自带本地服务（默认 `127.0.0.1:5173`），同时托管网页和 `/api/*` 源码接口
- 把令牌直接注入到页面里，网页「工程」面板**自动连上**工作区，不用手填
- 写回时若文件已在编辑器打开，走 `WorkspaceEdit` 保存，不会和编辑器缓冲打架

## 打包 / 安装扩展

```powershell
# 生成 llm-tuner-0.1.0.vsix（会自动把网页资源同步进扩展的 web/ 目录）
powershell -ExecutionPolicy Bypass -File .\scripts\package-vsix.ps1

# 安装
code --install-extension .\llm-tuner-0.1.0.vsix
```

装好后重载窗口（命令面板 `Developer: Reload Window`），左侧活动栏就会出现 **LLM_Tuner** 图标。

> 打包脚本只用 Node（VS Code 自带的 Electron 即可运行 `ELECTRON_RUN_AS_NODE=1`），
> 不需要 npm，也不需要 vsce。

### 关于内置浏览器里的串口

VS Code 内置浏览器本质是 iframe，浏览器不允许它申请 Web Serial 权限，因此：

- 在内置浏览器里可以用 **模拟数据源**、看「工程/代码」映射、用智能体；
- 要接真实串口，点侧边栏面板里的 **「在系统浏览器中打开（串口可用）」**，其余功能完全一致。

## 智能体

顶部 **智能体** 打开抽屉，填 Base URL / 模型 / API Key（OpenAI 兼容 `/chat/completions`，如 DeepSeek）。可用工具：

`list_params`、`read_values`、`get_samples`、`get_stats`、`set_param`、`set_transmit`、`raw_write`、
`get_status`、`list_source_files`、`read_source_file`、`find_param_code`

Key 只存在本机 localStorage，请求只发往你填写的地址。

## 已知限制

- Web Serial 只在 Chromium 内核 + 安全上下文（localhost/https）下可用；不支持的浏览器会用「模拟数据源」提示。
- 浏览器没有枚举 COM 口的能力，第一次要点「授权 / 添加端口」在系统弹窗里选设备；之后会记住。
- 后台标签页里 `requestAnimationFrame` 会被暂停，界面刷新靠 250ms 定时器兜底；数据本身照常接收。
- 单个参数的环形缓冲默认 50000 点（约 8.3 分钟 @100Hz）。
