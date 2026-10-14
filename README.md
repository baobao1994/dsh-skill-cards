<div align="center">

# 🎴 dsh-skill-cards · 技能卡片

**把 DeepSeek Harness 的技能目录变成可交互的扇形游戏王卡组。**

*以图片卡片浏览本机技能 · 自定义封面与卡名 · 智能分类 · 墙 / 扇形双布局 · 抽卡揭示 · 一键注入当前会话*

[![npm version](https://img.shields.io/badge/npm-1.1.0-c9a24b)](https://www.npmjs.com/package/dsh-skill-cards)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org)
[![tests](https://img.shields.io/badge/tests-121%20passing-brightgreen)](test/)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。在**聊天输入框下方**放一个「技能」按钮，同时在**设置 → 技能**里内嵌完整管理器，点开是一个以**图片卡片**呈现的技能浏览弹窗。选中技能后**仅对下一条消息生效**（发送即自动移除）——不动磁盘、不污染全局目录。

[功能](#-功能一览) · [安装](#-安装) · [使用](#-使用) · [API](#-http-api-参考) · [开发](#-开发) · [疑难排查](#-疑难排查) · [贡献](CONTRIBUTING.md)

</div>

---

## 📸 效果

| 技能管理 | 卡牌浏览（墙 / 扇形） | 抽卡揭示 |
| --- | --- | --- |
| 分类筛选 / 搜索 / 多选 / ★ 常用 | 扇形：中央放大 + 两侧弧形展开 + WebGL 星云背景；墙：4/3/2 列网格 + 悬停 3D 倾斜 | 应用后卡背飞入 → 逐张 3D 翻面 |

---

## ✨ 功能一览

### 两个入口

- **聊天输入框下方「技能」按钮** — 注册在官方 `conversation.input.right` 槽位（输入框下方、发送按钮左侧），走官方槽位而非 DOM 探测，稳定可靠。
- **设置 → 技能** — 整个管理器**内嵌**在该设置项内（`settings.section`），点开即用，无需再开弹窗。

两个入口都是**会话级**槽位，宿主会把所属会话的 `sessionId` 直接传给它们，因此**多窗口天然隔离**——在 A 窗口应用的技能不会出现在 B 窗口。

> 插件入口（DSH 自带的插件管理面板）**不做任何改动**——本插件只管「技能的可视化浏览与按需引入」。

### 🎴 游戏王式卡面（按分类自动换装）

- 卡面为 TCG 结构：金属外框 + 属性徽章 + 名字条（星级）+ 插画窗（封面图优先，无图则显示名字缩写字纹）+ 描述框 + 右下 **ATK 数值（= 使用次数）**。
- **主题表驱动**：11 个内置分类各有专属框色 / 插画渐变 / 辉光（开发·橙、测试·绿、设计·紫、安全·红……）。自建分类查表不到时**按名字哈希生成色相**（饱和度/亮度锁定在卡框区间），任何后续新增分类都自动有一套和谐皮肤。
- **闪卡罕贵度**：约 1/8 的技能（名字哈希确定性）为 SR 卡，卡面带持续流动的斜向碎闪光泽，悬停任意卡也会扫光。无随机抖动 —— 同名技能每次都是同一个罕贵度。

### 🧊 扇形卡牌浏览（默认布局）

- **打开就停在卡组正中**：当前浏览卡位于**中央、尺寸最大、层级最高**，左右各有邻牌、逐格对称，所以第一眼就是完整扇形，两个方向也都能立刻走。两侧卡牌逐渐缩小并围绕底部中心旋转，保留可点击的重叠区域。点击侧牌会平滑移至中央；点击中央卡面或下方「勾选技能」切换业务勾选，浏览不改变已有多选。
- **三种翻牌方式，都跟手**：① **左右拖动卡牌** —— 鼠标与触屏都支持，卡面逐帧跟着指针走、松手自动吸附到最近的卡位（一次拖动最多带走 3 张，避免为了跟随而挂载整副卡组）；② **点中央卡两侧的空白** —— 点哪一边就往那一边翻一张；③ 左右按钮，或聚焦卡牌区域后按 **← / →**。首尾顶住、不循环跳转；中央卡下方显示当前名称、完整描述及勾选、常用、自定义按钮。
- 宽面板最多显示 **7 张**、挂载 **9 张**（含透明过渡缓冲卡，拖动时按跟随方向再扩几张）；窄容器自动减少数量。布局按实际面板宽度计算，保留已有卡面、封面素材和分类主题。
- 卡组区（窗口偏矮或描述较长时）**自己滚动但不显示滚动条** —— 那条贴右内沿的滚动条会割裂卡面与细节区；滚轮 / 触控板照常，聚焦卡组区后方向键、PageUp·PageDown、空格也能滚。
- 背景是 **WebGL 粒子星云**（three.js，随鼠标轻微移动，跟随明暗主题）。
- **降级行为**：WebGL 不可用 / three.js 加载失败时仅隐藏星云，仍使用扇形布局；系统「减弱动态效果」关闭切换等动态效果并跳过抽卡动画，布局与搜索、多选、改图、应用功能保留。关闭弹窗即释放 GPU。
- three.js 不在 DSH 客户端模块表里（`require('three')` 会抛错），所以插件**自带一份 UMD 版**（`vendor/three.min.js` v0.152.2），由宿主端以同源经典 `<script>` 提供 —— **不走 CDN，离线可用**。

### 🔀 布局切换（墙 / 扇形）

- **默认扇形**：没设置过偏好时打开就是上面的扇形浏览。工具栏右侧的 **「墙 / 扇」分段按钮**（两个真按钮，带 `aria-pressed`）可随时切换。
- **墙 = 网格卡墙**：4 / 3 / 2 列响应式铺开全部卡片，悬停有 3D 倾斜，进入墙模式时播**一次**入场波浪（之后不再重播）。墙模式面板高度随内容自适应，3 张卡不会留 82vh 空白。
- **偏好落盘在宿主端**：写在 `~/.dsh/skill-cards-stats.json` 的保留键 `_prefs`（`{ "layout": "fan" | "wall" }`），跟分类 / 封面一样属于用户数据，可被现有备份 / 迁移流程覆盖。走 `GET/POST /plugins/dsh-skill-cards/prefs`；客户端另用 `localStorage['dsh-skill-cards.layout']` 做首屏镜像，避免读到权威值前闪一下默认布局。
- **两个入口都生效**：浮层与「设置 → 技能」共享同一个面板组件，切换一处、另一处跟着变；偏好是**用户级**的，换窗口、重启 DSH 都保持。
- **切换不丢状态**：搜索词、分类筛选、多选全部保留；并保留**当前浏览的那张卡** —— 切到墙会把它滚进视口并短暂描边，切回扇形以它居中。
- **滚动条策略**：两种布局的卡组区（`.dsh-sc-stage`）都**不显示滚动条**，但滚动能力保留（滚轮 / 触控板 / 聚焦卡组区后的方向键与 PageUp·PageDown）。
- **非法值不落盘**：`POST /prefs` 收到白名单外的 `layout` 返回 **400 `unknown layout`**，存储保持原值；`GET /prefs` 总是返回补齐默认值的完整对象。

### 🗂️ 分类 / 常用 / 使用次数

- 每张卡按名称与描述**自动归类**到 11 个中文分组：开发 / 测试 / 设计 / 写作·文档 / 办公文档 / AI·智能体 / 流程·工程 / 研究·分析 / 技能·管理 / 安全 / 数据。
- 顶部**分类筛选 tab**（全部 / 常用 / 各分组，带计数）+ 右侧下拉框（默认 / 按使用次数 / 只看收藏）双通道筛选；★ 常用卡片**置顶**。
- **分类管理**：底部工具栏独立「分类管理」按钮可**新增 / 重命名 / 删除**用户自建分类。内置智能分类**只读**，自建分类自由编辑，新增分组会并入筛选与卡面主题。
- 卡面布局：标题 ≤2 行、描述 ≤6 行（卡面字号）、分类固定左下角、使用次数固定右下角。
- **中央卡稳定后**，卡面左上角工具栏在悬停时出现：`★ 常用 · 译 中文化 · ↺ 还原 · 原 原文 · 🎨 卡图 · 自定义`，一排在宽度不够时自动换行，任何宽度都不会被裁掉或互相压住。
- 点中央卡左下角的分类徽章弹出**分类菜单**（列出全部内置 + 自建分类）。菜单会**自动判断上下翻转**并限高滚动 —— 卡片贴近滚动区底部时朝上展开，分类再多也能一路选到最后一项，不会被相邻卡片盖住、也不会被裁掉。

### 🔍 查看技能原文（「原」按钮）

- 悬停卡面左上角的工具栏，点其中的**「原」**（在 ★ 译 ↺ 之后、🎨 之前），弹出该技能的**原始信息**：原始技能名、原始完整描述、来源目录。
- 为什么需要它：卡面会**中文化**（「译」），描述也被**裁剪成 6 行卡面字号** —— 翻译或超长描述之后，技能安装时原本写的是什么就看不到了。这里给的是**未经翻译/未经改写**的原文，可选中复制。

### 🖼️ 自定义封面 / 卡名

- 悬停卡面左上角的工具栏，点其中**「自定义」**（工具栏最后一项，唯一带文字的按钮），可填写**封面图 URL、标题、描述**；也可**从本机选图上传**。
- 上传的图片作为**文件**存到 `~/.dsh/skill-cards-images/`，配置里只存受保护的同源服务 URL —— **不存 base64**，防止配置被撑爆。支持 `png / jpg / webp / gif / svg`。
- 落盘于 `~/.dsh/skill-cards.json`，刷新即生效。

### 🎴 应用到下一条消息（抽卡仪式感）

- 点「应用到本次会话」：弹窗先关闭，暗金纹章卡背**依次飞入**屏幕中央，再**逐张 3D 翻面揭示**（间隔 420ms），SR 卡翻面瞬间金光爆闪。点击任意处 / `Esc` 可跳过；系统「减弱动效」时直接跳过。
- 成功引入的技能名以彩色标签出现在输入框「技能」按钮上方（约 4 秒后消失）。

#### 技能是怎么生效的

技能**不是**随消息一起发送的，也不会写进输入框。点击「应用」时，宿主端把它们注册到**当前会话的 skills 服务**上：

```
skills.register({ name, description, content, resourceBase, invocation, source })
```

所以从这一刻起，该会话的 agent 就一直能看到它们 —— 你发什么内容都会用上。标签只是**状态展示**，不是待发送的内容，不存在「重复发送」。

会话被关闭时，宿主会收到 `agent-removed` 事件并自动注销这些技能。

#### 一次性：发送后自动移除

**「应用」始终是一次性的。** 你选中的技能只服务于**下一条要发的消息**：按下回车时它们被自动注销，标签随之消失。下一条消息不会带上这批技能。

这正是本插件与「会话级常驻」的区别 —— 技能是**逐条消息按需装载**的，不会在你看不见的地方长期影响后续对话。

若想提前手动移除，点标签上的 × 或面板里的「全部移除」即可。

> **实现说明**：DSH 未对外暴露「消息已发送」事件（其提交状态机 `begin-submit` / `send-committed` / `commit-draft` 均为 `dsh-client-ui-conversation` 的内部实现）。而宿主**只在 `submit-settled` 且 `ev.ok` 后才清空编辑器**——即应答被接受之后，且回合进行中可能保留原文——所以「草稿变空」这个信号既滞后又不可靠。
>
> 最终采用宿主自身会响应的两个信号：**捕获阶段的 `keydown` Enter** 与**点击主按钮** —— 两者在宿主内部都归到同一个 `keyboard.submit(mode, …)` 入口。
>
> - **Enter**：监听宿主输入框标记 `div[role=textbox][data-composer-input]`，过滤 `Shift+Enter` 与输入法组合中的 Enter。必须在**捕获阶段**，因为宿主的键盘映射会在 Enter 上终止事件传播，冒泡阶段的监听器永远收不到。
> - **发送按钮**：宿主没给它 data 属性，且**发送与停止按钮共用同一个 `primary` 类**。因此以插件自己的按钮为锚点判断是否位于同一输入栏，再按 `primary` 类或发送文案匹配，并排除停止/取消类文案 —— 取消回合不算提交。

### 🌏 技能中文化

- 底部工具栏「中文化」打开批量面板：**① 生成提示词并复制**（列出所有未翻译技能）→ 粘到对话框发给 agent → **② 把返回的 JSON 粘回面板点「写入」**。
- 卡面左上角工具栏里的「译」按钮可单卡翻译。
- agent 也可**直接调接口写入**（免粘贴）：

```bash
curl -X POST http://127.0.0.1:19387/plugins/dsh-skill-cards/i18n \
  -H 'content-type: application/json' \
  -d '{"items":[{"name":"tdd","zh":"测试仪式","zhDesc":"红-绿-重构循环的守护者。"}]}'
```

- 翻译优先渲染中文名，无翻译则回退英文原名 —— **没翻译的技能照常显示**。未知技能名会被服务端跳过，不会污染配置。
- 中文化只影响**卡面**：想看技能原本的名字与描述，点卡面左上角工具栏里的**「原」**（见上一节），随时对照原文。

---

## 📦 安装

> [!IMPORTANT]
> **务必走官方安装器，不要手改 profile 的 `package.json` / `node_modules`。**
> DSH 桌面版把这四者当作**一个原子事务**；只改其中一部分会让 DSH 启动时判定组合不一致，并**写入最小安全配置**（表现为：其它插件全部消失、配置被重置）。

### 桌面版

```bash
# 桌面版必须用安装目录自带的 CLI，普通 dsh CLI 会被 Electron 独占拒绝
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add dsh-skill-cards
```

或直接用应用内 **设置 → 插件管理 → 添加**。

### Web 版

```bash
dsh plugin --profile web add dsh-skill-cards
```

### 从源码安装（贡献者）

```bash
git clone https://github.com/baobao1994/dsh-skill-cards.git
dsh plugin --profile web add "/absolute/path/to/dsh-skill-cards"
```

安装是纯 `insert` 的 `cordis.patch.yml`。若宿主代码未加载（弹窗打不开），**重启一次 DeepSeek Harness**；之后 `client/` 的改动刷新页面即可生效。

### 卸载

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop remove dsh-skill-cards
```

---

## 🚀 使用

1. **打开面板** — 点输入框下方的「技能」按钮，或进 **设置 → 技能**。
2. **筛选与搜索** — 顶部分类 tab + 搜索框（同时匹配中英文名与描述）。
3. **浏览** — 打开就停在卡组正中的那张。左右拖动卡牌（鼠标 / 触屏，跟手、松手吸附）、点中央卡两侧的空白、点侧牌直接居中、左右按钮或 **← / →** 都能翻牌。中央卡下方显示完整名称、描述及操作按钮。工具栏右侧的 **「墙 / 扇」** 可切换到网格卡墙；两种布局都保留搜索、筛选与多选，切换时还会保留当前浏览的那张卡。
4. **定制** — 中央卡稳定后，悬停其左上角工具栏：★ 设常用 · 译 中文化 · ↺ 还原 · 原 看原文 · 🎨 卡图 · 自定义 换封面与文案；点左下角分类徽章改归类。
5. **勾选** — 点中央卡面或详情区的勾选按钮切换选中，右上角复选框显示状态，可跨卡牌多选。浏览切换保留勾选；工具栏可全选当前筛选结果 / 清空。
6. **应用** — 点「应用到本次会话」，看抽卡揭示动画，确认技能已进入本会话。
7. **随时撤销** — 再次打开面板，已应用的技能带标记，再点一次即从本会话移除。

### 技能从哪来

插件**不提供技能市场**，只展示**本机已安装**的技能。列表为空时，把技能目录放到以下任一位置后刷新：

| 位置 | 说明 |
| --- | --- |
| `~/.dsh/skills/` | DSH 用户技能根目录 |
| `~/.agents/skills/` | Agent CLI 安装位置（主力） |
| `~/.claude/skills/` | Claude 兼容技能池 |
| `<项目>/.dsh/skills/` | 项目级 |
| `<项目>/.agents/skills/` | 项目级 |

每个技能是一个**直接包含 `SKILL.md` 的目录**（或扁平的 `<name>.md`）。`$DSH_HOME` 可覆盖默认的 `~/.dsh`。

#### 技能放在别处？

设置环境变量 `DSH_SKILL_CARDS_ROOTS` 指向任意目录，可同时指定多个：

```bash
# macOS / Linux 用 : 分隔
export DSH_SKILL_CARDS_ROOTS="/opt/skills:$HOME/dotfiles/agent-skills"

# Windows PowerShell 用 ; 分隔
$env:DSH_SKILL_CARDS_ROOTS = "D:\skills;E:\dotfiles\skills"
```

与默认路径重复的项会被自动忽略，放心列出。

#### 列表为空？先看扫描报告

列表为空时，面板会直接列出**本次实际扫描过的每个目录**及其命中数量 —— 不存在的目录标红删除线。这样能立刻区分「目录不存在」和「目录存在但没有有效技能」：

```
本次扫描的目录：
  ~/.agents/skills        无有效技能 · 0
  ~/.claude/skills        不存在          ← 红色：这个目录压根没有
  ~/.dsh/skills           无有效技能 · 0
```

技能名支持小写字母、数字、`-`、`_`、`.` 以及**大写字母** —— `GitHub`、`TDD` 这类来自其它 agent 的命名不会被静默丢弃。

同一技能出现在多个目录时**只显示一次**，优先级为 DSH 用户目录 > `.agents` > `.claude` > 自定义 > 项目级。

### 封面图自动识别

在技能目录（含 `SKILL.md` 的那一层）放下列任一文件名，即自动作为卡片插画：

```
cover.png   cover.jpg   cover.jpeg   cover.webp   cover.svg   preview.png   preview.jpg
```

想用任意图片，请用卡片上的「自定义」按钮上传，或填 http(s) 图片链接。

---

## 🔌 HTTP API 参考

所有路由挂在 `/plugins/dsh-skill-cards/` 下，并做**同源校验**（跨域请求返回 403）。仅本机 DSH 使用，无鉴权需求，请勿反向代理暴露到公网。

### GET

| 路由 | 说明 |
| --- | --- |
| `skills?cwd=<path>` | 已安装技能列表 + 合并后的分类表 + **扫描报告**（每个根目录的 `exists` / `found`） |
| `cards` | 全部自定义卡面配置 |
| `stats` | 分类 / ★ 常用 / 使用次数 + 自建分类 |
| `prefs` | 用户 UI 偏好（当前只有 `layout`：`fan` \| `wall`），总是补齐默认值 |
| `cover?skill=<name>` | 技能目录内的封面图（无则 404） |
| `image?id=<hash>.<ext>` | 上传图片回读（id 需匹配 `[a-f0-9]{24}\.(png\|jpe?g\|webp\|gif\|svg)`） |
| `active-session` | 当前活跃会话 id |
| `applied?sessionId=<id>` | 该会话已引入的技能名列表 |
| `vendor/three.min.js`、`vendor/card-back.jpg` | 插件自带的静态资源（白名单） |

### POST

| 路由 | body | 说明 |
| --- | --- | --- |
| `introduce` | `{ sessionId?, names: string[] }` | 把技能注册进**会话级** skills 服务 |
| `revoke` | `{ sessionId?, names: string[] }` | 从会话移除已引入的技能 |
| `cards` | `{ name, image?, title?, description?, i18n? }` | 写入卡面配置；`image: ''` 清除，`i18n: null` 清除中文层 |
| `i18n` | `{ items: [{ name, zh, zhDesc? }] }` | 批量写入中文卡名 |
| `stats` | `{ name, category?, starred? }` | 局部更新某技能统计 |
| `prefs` | `{ layout: "fan" \| "wall" }` | 写入 UI 偏好；白名单外的值返回 400，且存储保持原值 |
| `categories` | `{ action: "add"\|"rename"\|"remove", id?, label? }` | 分类管理 |
| `image` | raw body + `content-type: image/*` | 上传封面图，返回受保护的 URL |

---

## ⚙️ 工作原理

- **技能来源**：宿主端 [lib/skills-scan.js](lib/skills-scan.js) 扫描上述技能根，解析 `SKILL.md` 的 YAML frontmatter（`name` / `description`，支持行内、引号、块标量三种真实写法），并探测同目录封面图。
- **会话级引入**：`POST /introduce` → `ctx.get('agents')?.get(sessionId)` 取出当前会话的 agent → 对其**会话作用域**的 `skills` 服务调用 `register({ name, description, content, resourceBase, invocation, source })`。纯内存注册，重启前一直有效，不写任何技能目录。
- ** disposer 保留**：每次注册返回的 disposer 都存在 `sessionId → skillName → dispose` 的注册表里，因此技能**可以被撤销**；agent 移除时该表整块清理，避免出现「幽灵技能」。
- **当前会话判定**：两个入口都是**会话级槽位**（`scope: "session"`），宿主把所属会话的 `sessionId` 作为标准 props 直接传入。客户端优先取它，并在每次 `/applied`、`/introduce`、`/revoke` 时**显式带上**。
  > 宿主是**单进程、被所有窗口共享**的，所以任何「记住最近一次会话」的做法都会跨窗口串味——早期版本正是如此：A 窗口应用后，B 窗口因为没带 id 而拿到 A 的技能。会话 id 必须随每个请求传递，绝不留在宿主端的全局字段里。
- **数据落盘**：

| 文件 | 内容 |
| --- | --- |
| `~/.dsh/skill-cards.json` | 卡面配置（封面 URL / 标题 / 描述 / 中文层） |
| `~/.dsh/skill-cards-stats.json` | 分类 / ★ / 使用次数 / 自建分类 / **UI 偏好 `_prefs`**（与配置分离，高频写不搅动布局） |
| `~/.dsh/skill-cards-images/` | 上传的图片原始字节（按 sha256 前 24 位命名） |

### 客户端加载契约（给二次开发者）

`window.__ModuleLoader__.load({ id, factory })` 的 `factory` **只接收 `require` 一个参数**，DSH 不会传入 `module` / `exports`。必须自己造：

```js
factory: (require) => {
  const module = { exports: {} }
  const exports = module.exports
  Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
  // ...
  exports.name = 'dsh-skill-cards'
  exports.inject = ['slots', 'locale']
  exports.apply = apply
  return exports
}
```

写成 `factory: (require, module) => { const exports = module.exports }` 会在启动时抛
`Cannot read properties of undefined (reading 'exports')`，导致 `web boot: 1 entry did not activate`，进而触发上面的配置重置。

---

## 🗂️ 目录结构

```
dsh-skill-cards/
├── package.json          # 插件清单（no-build，web 客户端）
├── cordis.patch.yml      # 纯 insert 补丁，热挂载
├── vendor/
│   ├── three.min.js      # three.js v0.152.2 UMD（星云背景，同源经典 <script> 加载）
│   └── card-back.jpg     # 卡背雕花纹理
├── lib/                  # ── 宿主端（Node）
│   ├── index.js          #   HTTP 路由 / vendor 静态文件 / 封面服务 / 会话引入
│   ├── skills-scan.js    #   枚举本机技能 + 解析 frontmatter + 探测封面
│   ├── stats.js          #   分类 / 常用 / 使用次数 + 智能分类建议
│   └── http.js           #   HTTP 辅助（sameOrigin 闸门 / JSON / 文件）
├── client/
│   └── client.js         # ── 浏览器端：入口按钮 + 设置面板 + 卡片浮层 + 墙/扇形双布局 + 出卡
├── diagnose/             # ── 脱离 DSH 的自测页（真实 React 渲染）
└── test/                 # ── node:test 单测（122 个）
```

---

## 🛠️ 开发

```bash
npm install      # 无运行时依赖，仅为 diagnose 页拉取 React UMD
npm test         # node --test，122 个用例
npm run check    # 对所有源码做 node --check 语法校验
PORT=43691 npm run diagnose # 启动独立自测页 http://127.0.0.1:43691/diagnose/
```

若测试运行器只输出文件级结果，可逐个执行以查看子测试：`for file in test/*.test.mjs; do node "$file" || exit; done`。

**架构约束（改动时务必遵守）**

1. **宿主端只 `inject = ['webServer']`**。`skills` 是 agent 级服务，在根作用域 await 它会让 Cordis 的 `apply()` 永久挂起 —— 症状是按钮出现了但所有请求 404。需要 `agents` / `skills` 时用 `ctx.get()` **机会式**读取。
2. **路由前缀不带尾部斜杠**。宿主用 `pathname === prefix || pathname.startsWith(prefix + '/')` 匹配前缀路由，带斜杠会导致静默全量 404。
3. **绝不把 base64 写进配置**。图片以文件存储，配置只存同源 URL。
4. **`client/client.js` 不走构建**。JSX 需手工替换为 `React.createElement`，CSS 全部内联。
5. **只注入到会话作用域**。任何时候不要注册到宿主全局 skills 服务，否则会泄漏到所有会话。

---

## ❓ 疑难排查

| 症状 | 原因 / 解决 |
| --- | --- |
| 输入框下方没有「技能」按钮 | `conversation.input.right` 是会话级槽位，尚未进入会话时不渲染。改从 **设置 → 技能** 进入 |
| A 窗口应用的技能出现在 B 窗口 | 已修复（1.0.2）。两端都不会「记住」会话，id 随每个请求传递 |
| 分类菜单被旁边的卡片盖住 / 分类多时选不到最后几项 | 已修复（1.0.3）。菜单现在会抬到相邻卡片之上、按剩余空间限高滚动，并自动朝上/朝下展开 |
| 中文化后看不到技能原本的名字和描述 | 已修复（1.0.3）。卡面左上角工具栏里的「原」按钮可查看**未翻译的原文**（原始技能名 / 完整描述 / 来源） |
| 想换回网格卡墙（扇形之前的布局） | 工具栏右侧的「墙 / 扇」分段按钮随时可切，偏好会记住（宿主端 `_prefs`，见[布局切换](#-布局切换墙--扇形)）。默认是扇形 |
| 切牌时卡片底部的分类标签闪动 | 已修复（1.1.0）。标签改为恒挂载、过渡期只摘掉交互能力，不再卸载重挂，`.gc-stats` 行不再重排 |
| 卡片列表为空 | 技能没放在已识别的技能根目录（见上文表格）。面板会列出本次扫描过的目录，注意看哪个标红 |
| 卡片没有插画 | 目录内没有 `cover.*` / `preview.*` 文件。用卡面左上角工具栏里的「自定义」按钮上传或填 URL |
| 没有星云或切换动画 | WebGL 不可用 / three.js 加载失败会隐藏星云；「减弱动态效果」会关闭动画。扇形布局与操作仍然保留 |
| 弹窗一闪而过 / 设置空白 | 先跑 `PORT=43691 npm run diagnose` 打开 `http://127.0.0.1:43691/diagnose/`，看诊断日志两行是否都是 ✅。❌ 则把红字与 F12 Console 报错反馈到 [Issues](https://github.com/baobao1994/dsh-skill-cards/issues) |
| 装上后其它插件全没了 | 手改了 profile 的 `package.json`。用官方安装器重新添加，见[安装](#-安装) |
| **升级后改动没生效** | pnpm 因 `^版本号` 已满足而静默跳过（输出 `Already up to date`）。必须先 `remove` 再 `add`，见 [CONTRIBUTING](CONTRIBUTING.md#升级到新版本后先确认真的换了) |

### 单独自测 client.js

如果「点击技能弹窗一闪而过 / 设置空白」，先在真实 DSH 之外验证插件自身是否健康：

1. `PORT=43691 npm run diagnose` → 打开 <http://127.0.0.1:43691/diagnose/>。
2. 看「诊断日志」：两行都应是 ✅、无红色 ❌。
   - ✅ → client.js 在真实 React 下渲染正常 → 问题在 DSH 宿主侧。
   - ❌ → 把红字与浏览器控制台（F12 → Console）报错反馈回来。

诊断页支持 `?count=0`、`?count=1`、`?count=2` 和 `?count=95`，分别检查空结果、单卡、首尾边界和大卡组。例：<http://127.0.0.1:43691/diagnose/?count=95>。检查「打开即在正中且左右对称」「鼠标 / 触屏拖动跟手、松手吸附」「点两侧空白翻页」「侧牌点击」「中央勾选」「滚动条隐藏但可滚」「窗口缩放」「详情与分类弹层」「两种布局各自可用、切换后偏好保持（宿主端 `_prefs`）」，并确认拖动、点空白都不会误勾选。想要自动化回归，可复用本地脚本 `.shots/fan-check.mjs`（headless Chrome + CDP，零依赖，文件头注释里写了启动命令；`.shots/` 已 gitignore，不入库）。断言数随脚本增长，以脚本内的 `check()` 调用为准。

该页自带本地 React 副本，只需一次 `PORT=43691 npm run diagnose`，无需联网。

---

## 🤝 贡献

欢迎 PR！提交前请确保：

```bash
npm run check && npm test
```

- 新增功能同时补 `test/` 下的用例（当前 122 个）。
- 遵守上方 **架构约束** 五条，尤其是会话作用域与路由前缀。
- UI 改动请在支持 / 不支持 WebGL、以及「减弱动态效果」三种情形下各验一次。
- **UI 文案保持中英双语**（`locale.register` 的 zh / en 两份都要加）；README 目前只维护中文版。

**完整流程见 [CONTRIBUTING.md](CONTRIBUTING.md)** —— 里面记录了本项目特有的加载契约、会导致静默失效的坑，以及发版注意事项。

---

## 📄 许可

[MIT](LICENSE) © 2026 gww

本插件与 DeepSeek 官方无隶属关系。技能内容由各自作者所有。
