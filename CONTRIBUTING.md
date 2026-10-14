# 贡献指南

感谢你愿意改进 dsh-skill-cards。这个插件的形态比较特殊——**没有构建步骤**，一份 `client/client.js` 手工维护，因此下面几条约束比一般项目更重要。

本文档为中文版，英文说明见代码注释与 [README](README.md)。

---

## 开发环境

需要 **Node.js ≥ 20**（`engines` 已声明）。

```bash
git clone https://github.com/baobao1994/dsh-skill-cards.git
cd dsh-skill-cards
npm install      # 无运行时依赖，仅为 diagnose 页拉取 React UMD
```

### 用本地目录安装到 DSH

开发时不要反复发 npm 版本，直接指向本地目录：

```bash
CLI="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"   # macOS 桌面版
"$CLI" plugin --profile desktop add "/absolute/path/to/dsh-skill-cards"
```

> ⚠️ **务必用官方安装器。** DSH 把 `package.json`、`pnpm-lock.yaml`、`node_modules`、`bundles` 当作一个原子事务，手改其中一部分会导致启动时判定不一致，**写入最小安全配置**——表现为其它插件全部消失、配置被重置。

> ⚠️ **切换安装来源必须先 `remove` 再 `add`。** `dsh plugin add` 直接透传给 pnpm，而 `link:` 依赖与 npm 包名在 pnpm 眼里是同一个包，已存在时会被判为「已满足」而**什么也不做**（输出 `Already up to date`）。从本地开发版切回 npm 版，或反过来，都要先移除。

改完 `lib/` 需重启 DSH；只改 `client/` 刷新页面即可。

### 升级到新版本后，先确认真的换了

**升级同样必须 `remove` 再 `add`。** 这一点最容易踩：

```bash
# profile 里是 "dsh-skill-cards": "^1.0.0"，而 ^1.0.0 已经包含 1.0.1
"$CLI" plugin --profile desktop add dsh-skill-cards@1.0.1
# → Already up to date —— pnpm 认为 ^1.0.0 已被 1.0.1 满足，什么也没做
```

命令**看起来成功了**（退出码 0、无报错），但 `node_modules` 里仍是旧版本。正确做法：

```bash
"$CLI" plugin --profile desktop remove dsh-skill-cards
"$CLI" plugin --profile desktop add dsh-skill-cards@1.0.1
```

### 「改了没生效」时，先查版本再改代码

这是本项目最容易浪费时间的地方。**在根据现象修改任何代码之前，先确认宿主实际加载的是哪一份：**

```bash
# macOS
node -p "require('$HOME/.dsh/profiles/desktop/node_modules/dsh-skill-cards/package.json').version"
```

```powershell
# Windows
$p = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-skill-cards"
(Get-Content "$p\package.json" | ConvertFrom-Json).version
```

再确认文件内容确实是新版本（以 `max-height:82vh` 为例，它是 1.0.1 才有的）：

```bash
grep -c "max-height:82vh" ~/.dsh/profiles/desktop/node_modules/dsh-skill-cards/client/client.js
```

**为什么强调这一步：** 本地编辑项目目录里的源码，**不会**影响已安装的 npm 包或 `link:` 软链指向的内容。开发时改了文件、刷新页面看到变化，容易误以为是宿主加载了新代码——实际上可能一直在跑几个月前的旧版本。真实案例：设置页白底问题连续三次改代码都不生效，最终发现两个平台的 `node_modules` 里装的都还是最初的 1.0.0，修复代码从未被加载过。

**判断口诀：** 现象与预期不符时，先怀疑「跑的不是你以为的那份代码」，而不是「我的修复逻辑有问题」。

### 客户端改动是自动热重载的（不用重启，通常也不用刷新）

`client/` 是宿主**按需读取**的浏览器半边。`@deepseek-ai/dsh-client-hmr` 每 **500ms** 轮询每个已注册插件的客户端文件（比对 mtime / ctime / size）：文件一变，宿主立刻重新读盘、生成新的 `rev`，并通过 `GET /plugins/events`（SSE）向页面推一帧 `rebuilt`；浏览器半边收到后调用 `entries.reload(id, rev)` **就地重载该插件** —— 页面本身不用刷新。

所以在 `link:` 安装下，改完 `client/client.js` 保存即生效（约半秒内）。想确认宿主真的拿到了新代码，不用靠猜：

```bash
# 1) 订阅事件流，再 touch 一下触发重新发布
curl -sN http://127.0.0.1:19387/plugins/events &
touch client/client.js
# 看到 {"type":"rebuilt","id":"dsh-skill-cards","rev":"xxxx"} 就是已经重载了；
# 初始的 graph 帧里也能看到该插件当前的 rev

# 2) 把宿主"正在发"的那一份抓下来核对（rev 用上一步的）
curl -s "http://127.0.0.1:19387/plugins/??dsh-skill-cards/client.js&rev=xxxx" | grep -c 你新加的标记
```

宿主对每个 `rev` 做**不可变缓存**（旧 rev 绝不会被换成新字节），所以「rev 变了 + 页面已拿到新 rev」就等于「跑的是新代码」。改 `lib/`（宿主半边）不在此列 —— 那部分要重启 DSH。

---

## 提交前必跑

```bash
npm run check   # node --check 全部源码
npm test        # node --test，当前 121 个用例
```

两个都必须通过。新增功能请同时补 `test/` 下的用例。

若运行器只输出文件级结果，逐个执行 `for file in test/*.test.mjs; do node "$file" || exit; done`，检查各文件的子测试数量与失败信息。`test/fan.test.mjs` 覆盖扇形几何边界、浏览与多选分离、过滤、滑动和应用动画位置回退。

---

## 架构约束

这五条是踩过坑总结出来的，**违反任何一条都可能产生"看起来正常但实际静默失效"的 bug**。

### 1. 宿主端只 `inject = ['webServer']`

```js
export const inject = ['webServer']   // ✅
```

`skills` 是 **agent 级**服务。在根作用域 `await` 它会让 Cordis 的 `apply()` 永久挂起，导致 HTTP 路由**从未注册**——症状极具迷惑性：按钮出现了（客户端半边独立加载），但每个请求都 404。

需要 `agents` / `skills` 时用机会式读取，它在服务缺席时返回 `undefined` 而不会挂起 fiber：

```js
const agents = ctx.get('agents')          // ✅
```

### 2. 路由前缀不带尾部斜杠

```js
const API_PREFIX = '/plugins/dsh-skill-cards'     // ✅ 不能是 '/plugins/dsh-skill-cards/'
```

宿主用 `pathname === prefix || pathname.startsWith(prefix + '/')` 匹配前缀路由。带尾部斜杠会要求请求路径里出现**双斜杠**，于是所有路由静默 404，而日志里什么都看不到。

另外 DSH 只转发 `/api/*` 和 `/plugins/*`，选别的前缀会在到达插件前就被 shell 拦掉。

### 3. 绝不把 base64 写进配置

图片以**文件**形式存在 `~/.dsh/skill-cards-images/`，配置里只存同源服务 URL：

```json
{ "image": "/plugins/dsh-skill-cards/image?id=a1b2c3....png" }
```

`POST /cards` 会主动拒绝 `data:image/...`。一条 base64 图片就能把 `skill-cards.json` 撑到几百 KB。

### 4. `client/client.js` 不走构建

- JSX 需手工写成 `React.createElement`（文件里 `const e = React.createElement`）
- CSS 全部内联在 `CSS` 模板字符串中
- ⚠️ **CSS 模板字符串内绝对不能出现反引号。** 注释里写 `` `foo` `` 会提前闭合外层模板字符串，报 `SyntaxError` 且破坏整个客户端模块。写注释用普通引号。

### 5. 只注入到会话作用域

```js
const skills = agent.ctx?.get?.('skills')          // ✅
skills.register({ name, description, content, resourceBase, invocation, source })
```

注册到**宿主全局** skills 服务会让技能泄漏进所有会话。`register()` 返回的 disposer **必须保存**（`sessionId → skillName → dispose`），否则技能无法撤销——早期版本把 disposer 丢掉了，导致"撤销"只能靠重启会话。

agent 移除时要清理整张表，否则 UI 会列出已经死掉的"幽灵技能"。

---

## 客户端加载契约

```js
factory: (require) => {
  const module = { exports: {} }
  const exports = module.exports
  Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
  // ...
  return exports
}
```

`factory` **只接收 `require` 一个参数**，DSH 不会传入 `module` / `exports`，必须自己造。

写成 `factory: (require, module) => { const exports = module.exports }` 会在启动时抛 `Cannot read properties of undefined (reading 'exports')`，进而触发 `web boot: 1 entry did not activate`，**最终导致上面说的 profile 配置重置**。

---

## UI 改动请覆盖三种情形

扇形布局不依赖 WebGL，动 UI 时请至少各验一次：

1. **WebGL 可用** —— 扇形浏览 + 星云背景，中央卡最大且层级最高，两侧平滑缩放和旋转
2. **WebGL 不可用 / three.js 加载失败** —— 仅隐藏星云，扇形布局及搜索/多选/改图/应用必须全部照常可用
3. **系统开启「减弱动态效果」** —— 关闭切换等动态效果并跳过抽卡动画，仍保留扇形布局和全部操作

外加**弹窗**与**设置 → 技能**两个入口都要看——它们共享 `SkillsPanel` 组件但包裹层不同，CSS 上下文也不同（这是白底与滚动问题的来源）。

检查：打开时中央卡**正好在卡组正中且左右逐格对称**；点击侧牌只使其居中，点击中央卡或下方详情区按钮才切换勾选；**鼠标与触屏左右拖动都跟手**（拖动中卡面跟着指针、`is-current` 高亮已指向吸附目标、松手吸附到最近卡位、拖动过程不产生勾选），**点中央卡两侧的空白各翻一张**，方向键与左右按钮同样可浏览。首尾顶住不越界，纵向滚动与横向拖动不互相误触。确认中心下方名称、完整描述和操作按钮可见，中央卡稳定后分类/原文弹层可操作。宽容器最多 7 张可见、9 张挂载（含透明缓冲卡，拖动时按跟随方向再扩几张），窄容器应减少数量；缩放窗口和调整设置栏宽度后，卡牌不得溢出或遮挡主要操作。切牌（点侧牌 / 方向键 / 拖动 / 左右按钮）时**当前卡的分类标签与 ATK 数值不得闪动**：标签必须始终是同一个 DOM 节点（过渡期只摘掉交互能力，不卸载重挂），`.gc-stats` 行的布局高度全程不变。

**墙 / 扇切换**（工具栏右侧「墙 / 扇」分段按钮，两个入口共享同一面板，改一处另一处跟着变）：

- **默认扇形**：没设置过偏好时打开即为扇形。偏好落盘在宿主端 stats 文件的保留键 `_prefs`（`~/.dsh/skill-cards-stats.json`，走 `GET/POST /plugins/dsh-skill-cards/prefs`），所以**换窗口 / 重启 DSH 后仍是上次布局**；非法 `layout` 值 POST 返回 400 `unknown layout` 且存储保持原值。
- **切换保留状态**：搜索词、分类筛选、多选都不重置；并保留**当前浏览的那张卡** —— 切到墙会把它滚进视口并短暂描边（`.focus-flash`），切回扇形以它居中。墙模式为 4 / 3 / 2 列响应式，悬停 3D 倾斜，进入墙模式只播**一次**入场波浪。
- **两种布局都不显示卡组区滚动条**（`.dsh-sc-stage`），但滚轮、触控板、聚焦卡组区后的方向键 / PageUp·PageDown 必须仍能滚；墙模式高度随内容自适应，3 张卡不留大片空白。
- **`prefers-reduced-motion` 下两种布局都不播动画**：墙的入场波浪与切换时的 `.focus-flash` 脉冲都关掉，后者退化为静态描边；布局本身与搜索 / 多选 / 改图 / 应用功能保留。

卡组区（`.dsh-sc-stage`）是插件唯一的纵向滚动容器：内容溢出时**不应出现滚动条**（否则那条贴右内沿的滚动条会割裂卡面与细节区），但滚轮、触控板、聚焦卡组区后的方向键 / PageUp·PageDown 必须仍能滚，且滚到底部时详情区按钮要完整可见。别把这条 CSS 扩大到宿主设置页的滚动容器上。

拖动相关的手势判定集中在 `CardFan` 内（`FAN_DRAG_START` / `FAN_CLICK_SLOP` / `FAN_DRAG_MAX` + `clampDragUnits`），阈值改动请同步跑 `test/fan.test.mjs` 里的手势用例。

### flex 滚动容器的常见坑

某个子元素要成为滚动容器，必须同时满足：`flex:1 1 auto` + `min-height:0` + **父链上有确定高度**。

`height:100%` 在父容器无高度时会解析为 `auto`，此时 `overflow-y:auto` **永不触发**——内容撑开，真正的滚动变成宿主外层面板，表现为"只有最右侧滚动条能动，鼠标悬停卡片无反应"。必要时用 `max-height: Nvh` 给出确定高度。

---

## 自测工具

```bash
PORT=43691 npm run diagnose    # → http://127.0.0.1:43691/diagnose/
```

脱离 DSH 用真实 React 渲染弹窗与设置面板。**改动 `client/client.js` 后请先跑这个**，能立刻区分"插件自身坏了"还是"宿主侧问题"。

分别访问 `/diagnose/?count=0`、`?count=1`、`?count=2`、`?count=95`，覆盖空结果、单卡、首尾边界和大卡组。例如：<http://127.0.0.1:43691/diagnose/?count=95>。

页内诊断日志也可在真实 DSH 中开启：

```js
localStorage.setItem('dshSkillCardsDiag', '1')   // 或访问带 ?scDiag=1
```

它会打印卡背贴图的分层尺寸与加载状态——排查 3D 卡面塌缩类问题时非常有用。

---

## 提 Issue

请附上：

- DSH 版本、操作系统
- 复现步骤
- F12 → Console 的报错
- **空列表问题请附面板里的"本次扫描的目录"报告**——它会直接显示哪个路径不存在或没有有效技能，比猜测有效得多
- 若是扫描问题，可附上你的技能实际位置（注意先移除敏感信息）

---

## 提 PR

1. 从 `main` 切分支：`git checkout -b fix/short-description`
2. 改动 + 补测试
3. `npm run check && npm test` 全绿
4. 提交信息用中文，**写清「为什么」而不只是「改了什么」**——本项目的历史里，`fix: 移除全部 CSS color-mix（引擎兼容性根因）` 这类记录对后来者价值很高
5. 中文 README 与代码注释保持同步

### 发版（仅维护者）

```bash
npm version patch     # 或 minor / major
npm publish --registry=https://registry.npmjs.org/
```

⚠️ **`--registry` 必须显式指定。** 若你的 `~/.npmrc` 指向 npmmirror 之类的镜像，发布需要覆盖成官方源。

发布后把改动同步到 GitHub。npm 包名一旦发布即永久占用，同名同版本无法覆盖，只能发新的 patch/minor 版本——**发版前请务必在真实 DSH 中验证一遍**。

---

## 代码风格

沿用现有风格，不引入新的格式化工具：

- 2 空格缩进，单引号，无分号
- 注释用中文，说明 **为什么** 而非复述代码
- 导出函数带 JSDoc
- 标识符用英文，UI 文案走 `STRINGS` 的 `zh` / `en` 双语表

新增 UI 文案时**两种语言都要补**，缺一个会在切换语言时显示 `undefined`。

---

## 许可

提交贡献即表示你同意该作品按 [MIT](LICENSE) 许可发布。
