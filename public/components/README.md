# 前端组件（零依赖 ES Module）

为「极度降低资源占用 + 现代化 UI」重构而写的一组独立性组件。
**不引入 Vue / Vite / Tailwind**，保持项目原有的零构建单文件架构 —— 直接放进 `public/` 由浏览器原生加载。

## 文件

| 文件 | 作用 |
|---|---|
| `virtual-task-table.js` | 虚拟滚动任务列表（500~20000 条，DOM 常驻 ~16 行） |
| `log-viewer.js` | 日志滚动查看器（行级虚拟化、自动滚底、高频追加不卡） |
| `stat-cards.js` | 毛玻璃统计卡片（类 HyperOS，深/浅色模式完备） |
| `poller.js` | 轮询退避 / 节流 / 防抖 / 数据指纹（数据层） |
| `skin-manager.js` | 本地化皮肤与个性化定制（壁纸 / 遮罩 / 卡片透明度 / 模糊） |
| `demo-all.html` | 压测演示页，含 FPS 与 DOM 计数探针 |

皮肤配置在 `public/skins/*.json`：

| 文件 | 作用 |
|---|---|
| `index.json` | 皮肤清单，列出要加载哪些皮肤 id |
| `default.json` | 纯净原版（无壁纸） |
| `midnight.json` | 午夜沉浸（深蓝星野 · 卡片半透） |
| `frost.json` | 霜白极简 |
| `sakura-night.json` | 夜樱流光（自带 accent 与主题联动） |

> **新增皮肤 = 往 `skins/` 丢一个 json，再往 `index.json` 的数组里加一行 id。**
> 不需要改任何 JS。

## 本地查看演示

ES module 受 CORS 限制，**不能直接双击打开 html**，需要起一个静态服务：

```bash
# 任选其一，在项目根目录执行
npx serve public
# 或
python -m http.server 8000 --directory public
```

然后访问 `/components/demo-all.html`。

## 接入现有 index.html

**已经完成接入**（见 `public/index.html`）。当前状态：

| 位置 | 组件 | 挂载点 |
|---|---|---|
| 概览页统计卡片 | `StatCards` | `#statCards` |
| 任务管理列表 | `VirtualTaskTable` | `#taskTable` |
| 日志浮层 | `LogViewer` | `#logView` |
| 任务轮询 | `Poller` | `tasksPoller`（boot 内启动） |

接入要点（改动过的三处）：

1. `<body>` 补 `data-scheme="dark"` —— 显式声明配色方案，**必须写**。
2. `<script>` 改成 `type="module"` 并在顶部 import 四个组件。
3. 删除原 `drawTasks()` 的全量 `innerHTML` 重建、`$("ovText").textContent=...`、
   `setInterval(...,30000)` 三处旧实现。

API 用法（`index.html` 里的实际调用）：

```html
<script type="module">
import { VirtualTaskTable } from "./components/virtual-task-table.js";
import { StatCards } from "./components/stat-cards.js";
import { LogViewer } from "./components/log-viewer.js";
import { Poller } from "./components/poller.js";
</script>
```

### ① 任务列表

```js
vt = new VirtualTaskTable({
  mount: $("taskTable"),
  onAction: async (act, task) => { /* log / run / enable / disable 四种操作 */ },
});
vt.setData(tasks);          // 全量灌入，内部自己过滤
vt.setQuery("camel");       // 内置 180ms 防抖
vt.setFilter("running");
```

> ⚠️ 一定要在 `page("tasks")` 里补一句 `requestAnimationFrame(() => vt.refresh())`。
> 原因：`#tasks` 初始是 `display:none`，容器高度为 0，虚拟表格算不出可视行数
> （实测 `clientHeight === 0`，只能渲染 17 行且滚动位置无意义）。
> 切页时强制重排一次即可 —— 虽然 `ResizeObserver` 多数情况下也会兜住，
> 但显式调用不依赖它的触发时机。


### ② 统计卡片

```js
cards = new StatCards({ mount: $("statCards") });
cards.setData([
  { key:"total",    label:"任务总数",     value:4200, hint:"定时任务",       tone:"accent", icon:"▦" },
  { key:"running",  label:"运行中",       value:352,  hint:"状态：运行中",   tone:"green",  icon:"▶", pulse:true },
  { key:"recent24", label:"24h 内执行过", value:1860, hint:"按上次执行时间", tone:"accent", icon:"◔", progress:0.44 },
  { key:"disabled", label:"已禁用",       value:324,  hint:"未参与调度",     tone:"amber",  icon:"⏸", progress:0.077 },
]);
```

注意：数字用 `setData` 全量下发即可，组件内部只更新差异字段、不重建 DOM。

> 需要在页面根元素加 `data-scheme="dark"` 或 `"light"` 来显式声明配色方案，
> 否则会跟随系统偏好（详见下方「深浅色模式」）。

### ③ 日志查看器

```js
lv = new LogViewer({ mount: $("logView"), title });
lv.setContent(text);              // 一次性灌入整份日志
lv.append(chunk);                 // 增量追加（轮询 / SSE），内部 rAF 合并
lv.scrollToBottom(true);          // true = 瞬时到底（初次载入用），省略则平滑
```

### ④ 数据层轮询

```js
tasksPoller = new Poller({
  interval: 30000,
  fetcher: () => api("/api/tasks"),
  onData: (result, meta) => {
    setConn(true);
    if (!meta.changed) return;            // 内容没变就完全跳过渲染
    tasks = result.data || [];
    render();
  },
  onError: (e, meta) => {
    if (e.message === "需要登录") return;
    setConn(false, e.message);
    console.warn(`第 ${meta.failures} 次失败，下次 ${(meta.nextInterval/1000)|0}s 后重试`);
  },
});
tasksPoller.start();
```

替换掉了原来的 `setInterval(() => { if (!document.hidden) loadTasks() }, 30000)`。
系统监控页的 5 秒轮询保持原样未动。


### ⑤ 皮肤 / 个性化定制

```js
import { SkinManager } from "./components/skin-manager.js";

const skin = new SkinManager({
  onChange: (state, changedKeys) => {
    syncSkinControls(state);                         // 回填滑块 / 开关 / 输入框
    const root = document.documentElement.style;
    root.setProperty("--sc-skin-rgb", "255 255 255"); // 空格分隔！
    root.setProperty("--sc-skin-alpha", ...);         // 卡片底白的不透明度
    root.setProperty("--sc-xp", ...);                 // 透明程度 0~1，供面纱/文字提亮
  },
});

await skin.loadList();        // 读 skins/index.json + 各皮肤
skin.use("midnight");         // 切换皮肤（状态由 localStorage 持久化）
skin.setWallpaper(url);       // 壁纸 URL 或 dataURL（本地文件走 FileReader，不上传）
skin.setMask(0.62);           // 全局遮罩不透明度
skin.setImmersive(true);      // 沉浸模式开关
skin.setCardAlpha(0.42);      // 沉浸模式下的卡片不透明度
skin.setBlur(16);             // 毛玻璃模糊半径
skin.reset();                 // 回到默认
```

状态通过 CSS 变量注入 `:root`，**全程不刷新页面**：

| 变量 | 含义 |
|---|---|
| `--skin-wallpaper` | 壁纸（`none` 或 `url(...)`） |
| `--skin-masked` | 是否处于"有壁纸"状态（0/1），控制壁纸层淡入淡出 |
| `--skin-mask` | 全局遮罩不透明度（壁纸之上的压暗层） |
| `--card-alpha` | 卡片不透明度（1 = 实心；与页面 `.card` 共享） |
| `--skin-blur` | `backdrop-filter` 模糊半径 |
| `--skin-accent` | 皮肤自带强调色（可选，空则用主题的） |

渲染层是 `body` 上的两个伪元素，都在内容之下：

- `body::before` → `z-index:-2`，壁纸本体（`background-attachment:fixed`）
- `body::after`  → `z-index:-1`，遮罩压暗层，`opacity = --skin-mask × --skin-masked`

**主题与皮肤正交**：主题（`body[data-theme]`）管色相，皮肤管材质（壁纸/遮罩/透明度/模糊）。
切主题不会丢壁纸，换皮肤也不会改色相。


---

## 实测数据（Chrome 真实运行，非估算）

### 接入 `index.html` 后的端到端验证

用真实 `server.js`（`express.static`）起服务，puppeteer 驱动真实 Chrome，
`/api/*` 全部拦截注入 4,200 条假任务：

| 断言项 | 结果 |
|---|---|
| 4 个组件模块加载 | 全部 `200 application/javascript` |
| 页面错误 / 控制台错误 / 请求失败 | **0** |
| 统计卡片 | 4 张，`blur(14px) saturate(1.5)`，`tabular-nums` |
| 数字对比度（深色） | **9.09 : 1**（WCAG AAA 要求 7:1） |
| 虚拟列表 4,200 条 | DOM 仅 **17 行**，sizer `235200px` = 4200×56 精确 |
| 滚到底 末行 idx | **4199** = `N-1` ✓ |
| 搜索「农场」 | 840 条命中，DOM 仍 17 行 |
| 筛选「已禁用」 | 324 条 |
| 日志查看器 3000 行 | 容器 545px，DOM 36 行，行高 21px，自动滚到底（距底 0） |
| 浅色模式（`data-scheme="light"`） | 数字转 `rgb(91,62,214)` / 卡片 `rgba(255,255,255,.66)`，对比度正常 |

### 虚拟列表

| 场景 | DOM 行数 | 说明 |
|---|---|---|
| 5,000 条初始 | 16 | sizer = 280000px（= 5000×56，精确） |
| 5,000 条滚到底 | 16 | 末行 idx=4999，无累积漂移 |
| 20,000 条 | 16 | sizer = 1,120,000px |
| 20,000 条滚到底 | 16 | 末行 idx=19999 |
| 60 帧连续滚动 | 16↔23 | 全程 760ms，DOM 波动来自缓冲行 |

**DOM 节点数与数据量完全解耦。**


### 日志查看器

| 场景 | 结果 |
|---|---|
| 20,000 行 setContent | **9ms** |
| 100,000 行 / 2.5MB setContent | **43ms**（超出 maxLines 自动截断） |
| 2 秒内追加 100 行 | FPS 140，DOM 稳定 35 行 |
| 20,000 字符单行 | 行高仍为 21px（不撑破虚拟化前提） |
| 滚动到中部 | 仅渲染 35 行 DOM |

### 轮询

| 场景 | 结果 |
|---|---|
| 页面隐藏（切 tab） | 请求完全停止 |
| 回到前台 | 立即补拉一次 |
| 数据未变化 | 跳过渲染回调（指纹比对） |
| 连续失败 | 指数退避 30s → 54s → 97s…（上限 5 分钟） |
| 慢请求未返回 | 跳过本次，不堆积 |

### 皮肤系统

用真实 `server.js` + 真实 Chrome，通过暴露的 `window.qld.skin` 驱动状态机：

| 断言项 | 结果 |
|---|---|
| 皮肤列表加载 | 4 个（纯净原版 / 午夜沉浸 / 霜白极简 / 夜樱流光） |
| 切换 `midnight` | 壁纸 / 遮罩 / 卡片透明度 / 模糊 四项全部实时生效 |
| 遮罩滑块 → 30% | `--skin-mask: 0.3`，同步写回控件文案「30%」 |
| 沉浸关闭 | `--card-alpha` 回到 `1` |
| 沉浸开启 + 25% | `--card-alpha: 0.25`，卡片底 `rgba(255,255,255,0.15)` |
| 壁纸层 | `::before` opacity `1` / `::after` opacity `0.3` |
| 刷新页面后 | 皮肤与参数完整还原（localStorage） |
| 主题正交性 | 切到 jade 主题后壁纸与透明度均保留 |
| 控制台错误 | **0** |

### 可读性（像素采样，非 `getComputedStyle`）

**故意用「纯白壁纸」做最坏情况压测**（比任何真实照片都亮），
在卡片内取非文字像素、按 WCAG 相对亮度算真实对比度：

| 场景 | 最坏背景 | 对比度 | AA 4.5 |
|---|---|---|---|
| 非沉浸 · 统计卡片次要文字 | `rgb(20,20,30)` | **6.04 : 1** | ✓ |
| 非沉浸 · 面板次要文字 | `rgb(17,17,27)` | **6.19 : 1** | ✓ |
| 沉浸 25% / 遮罩 30% · 卡片 | `rgb(67,67,68)` | **5.63 : 1** | ✓ |
| 沉浸 25% / 遮罩 30% · 面板 | `rgb(57,57,59)` | **6.56 : 1** | ✓ |
| 沉浸 0%（全透）/ 遮罩 0%（边界） · 卡片 | `rgb(33,33,33)` | **10.77 : 1** | ✓ |
| 沉浸 0% / 遮罩 0% · 面板 | `rgb(53,53,53)` | **8.20 : 1** | ✓ |
| 沉浸 45% / 遮罩 62% · 卡片 | `rgb(72,72,74)` | **4.53 : 1** | ✓ |
| 沉浸 45% / 遮罩 62% · 面板 | `rgb(37,37,41)` | **7.57 : 1** | ✓ |

**8/8 通过 WCAG AA**（最差 4.53:1）。
修复前最坏场景只有 **3.62:1**，属于不达标。

---

## 设计取舍（重要）

### 为什么任务表用「定高行」

虚拟滚动的硬前提是行高恒定。原表格的任务命令会折行，因此改为**单行省略 + `title` 挂全文**。
这是必须的取舍 —— 展开看完整命令的诉求交给「日志 / 详情」入口。

### 为什么日志行不折行

同理。超长行（实测 2 万字符）走横向滚动，保证行高恒为 21px。

### 深浅色模式

组件默认**深色为基调**（与项目现有四套主题一致）。

- `data-scheme="dark"` / `"light"` → 显式指定，优先级最高
- 都不写 → 跟随系统 `prefers-color-scheme`

⚠️ **务必在页面根元素显式声明 `data-scheme="dark"`**。原因：无头浏览器、
部分 Linux 桌面、以及某些系统默认报告 `light`，若不显式声明，深色面板会被
浅色玻璃变量覆盖，出现「浅底 + 浅字」导致数字看不清。

`stat-cards.js` 的玻璃变量与项目的 `body[data-theme]` 色相变量**正交**：
四套主题（aurora/ocean/jade/sakura）只覆写 `--accent` 等色相，玻璃参数由组件统一提供，
所以新增主题不需要再补玻璃变量。

### 性能降级

- `backdrop-filter` 有合成开销 → 用 `@supports` 守卫，不支持时退化为实心面板色
- `prefers-reduced-motion` → 关闭位移与动画，保留静态玻璃观感

---

## 踩坑记录（改代码前请先读）

### 0. 单页应用里，隐藏视图中的虚拟列表量不出高度

接入 `index.html` 时踩到的：`#tasks` 初始是 `display:none`，
容器 `clientHeight === 0`，虚拟表格算不出可视行数 ——
实测只渲染 17 行、`sizer` 高度倒是写对了、但滚动位置完全无意义
（滚到底拿到的 `lastIdx` 是 6 而不是 4199）。

**规则：虚拟滚动组件必须保证「挂载时容器可见」或「进入视图时强制 refresh()」。**
本项目的做法是在 `page(name)` 里补一句
`if(name==="tasks"&&vt) requestAnimationFrame(()=>vt.refresh())`。
不要只依赖 `ResizeObserver` —— 它能兜住绝大多数场景，但触发时机不由你控制。

### 1. `[hidden]` 会被自定义 CSS 的 `display` 覆盖

`.vt-empty{display:flex}` 与浏览器默认的 `[hidden]{display:none}` **同权重、后写者胜**，
导致 JS 已设 `hidden` 属性但元素仍显示 —— 表现为「暂无任务」浮在列表正中间。

**规则：任何用 `hidden` 属性控制显隐、且自身带 `display:` 的元素，必须补一条 `.xxx[hidden]{display:none}`。**

### 2. `contain:strict` 会让 `flex:1` 解析为 0

日志滚动区曾用 `flex:1` + 父级 `contain:strict`，父容器无确定高度时 `flex:1` 算出 0，
滚动区高度为 0，**完全无法滚动**，且「上滚暂停跟随」永远不触发
（`scrollHeight - scrollTop - clientHeight` 恒为 0）。

**规则：`contain:strict`（含 size 隔离）的元素必须给确定高度，别依赖 flex 拉伸。**

### 3. 不要用 IntersectionObserver 推断「用户是否在底部」

底部哨兵位于绝对定位、高度动态的 sizer 内，内容重排 / 容器 resize / 行数变化都会
重新触发 IO 回调。实测把 `scrollTop` 设为 0（用户明明在顶部）仍收到 `isIntersecting=true`，
于是跟随被置回 true、未读计数被清零 —— **用户的「暂停」意图被静默覆盖**。

**规则：跟随状态属于「用户意图」，只由真实滚动位置决定，别让布局观察器推断。**

### 4. 高频追加时别用数组 `shift()`

`parts.shift()` 在循环里会对整个数组做搬移，2 万行时是 O(n²)，
实测渲染耗时 2.2s 主要就烧在这里。

**规则：用下标游标 + `push`，或一次性 `splice`，避免在循环里 `shift`/`unshift`。**

### 5. `setContent` 的成本在大文本的「解析」而非「渲染」

组件内部按 `maxLines × 120` 字符做预算预裁剪，先切掉头部再 `split`，
避免对整份文本做正则扫描。若要显示超长日志，请用 `append()` 分片喂入。

⚠️ 用 `Node.js --check` 之外的**浏览器**验证性能时，注意别把「造测试数据」的耗时算进组件。
实测 `toLocaleString` 调用 10 万次要 6.5s，而组件解析同量文本只要 43ms。

### 6. RGB 三元组必须**空格分隔**，否则整条声明被静默丢弃

给「运行时可变 alpha」的底色，必须写成 `rgb(var(--x-rgb) / var(--alpha))`。
这要求 `--x-rgb` 的值是**空格分隔**的三元组：

```css
--panel-rgb: 17 17 27;              /* ✓ 正确 */
--panel-rgb: 17,17,27;              /* ✗ 语法非法 */
background: rgb(var(--panel-rgb) / .5);   /* 上面写错时，这条声明被整条丢弃 */
```

`rgb(<channels> / <alpha>)` 的现代斜杠语法不接受逗号分隔的通道。

**为什么特别坑**：声明非法时浏览器**直接丢弃该属性，不报错、也不回退**。
更糟的是如果这条规则的选择器权重更高（例如 `.sc-card[data-skin]` 比 `.sc-card` 高），
那么低权重的 `background: var(--sc-bg)` 兜底**也救不回来** ——
元素背景变成完全透明，`getComputedStyle` 返回 `rgba(0,0,0,0)`，
而 devtools 的 Styles 面板里那条坏规则的属性名旁边只有一个小小的删除线。

**规则：凡是出现 `rgb(var(--*-rgb) / ...)` 的地方，`--*-rgb` 一律写成空格分隔三元组。**

### 7. 一个元素只有一个 `::after` —— 两条规则会「合并」而不是「覆盖」

给 `.sc-card` 写了角落光晕（`.sc-card::after`），
又给 `.sc-card[data-skin]` 写了本地面纱（`.sc-card[data-skin]::after`）。

预期是后者覆盖前者，实际是**两条规则合并**：冲突的属性（`background`）由高权重的胜出，
但**不冲突的属性会同时生效** —— 光晕的 `top/right/width/height` 泄漏到了面纱上，
表现为卡片右侧出现一块非常显眼的浅色方块（截图一眼可见）。

**规则：需要两个装饰层时，让其中一个用真实子元素（这里是 `div.sc-glow`），
不要指望用两条 `::before` / `::after` 规则叠两个效果。**

### 8. 「透明程度」这个语义只该有**一个**定义，别在同一变量上混两种约定

统计卡片的 `--sc-skin-alpha` 一度用 `0.045` 表示「实心」、`0.25` 表示「半透」，
而页面的 `--card-alpha` 用 `1` 表示「实心」、`0` 表示「全透」。
两套约定在同一个公式 `1 - alpha` 上相遇时直接爆掉：

- `1 - 0.045 = 0.955` → 把一张本该浅色实心的卡片压成暗块（整片亮度掉到 L≈175）
- `1 - 1 = 0` → 又在非沉浸态把面纱关掉，与上一条矛盾

**规则：跨组件传递「透明度」时，统一约定 `1 = 实心，0 = 全透明`，
并额外导出一个语义明确的派生变量（这里是 `--sc-xp` = 透明程度）给下游用，
不要让下游去猜某个 magic number 到底是实心还是透明。**

### 9. 全局遮罩**保证不了**单个元素的对比度

一开始的思路是「用全局遮罩把整屏压暗，文字就都能看清了」。
实际上遮罩只能控制**平均亮度**，而卡片完全可能正好落在壁纸最亮的那一块上
（实测卡片压在照片的天空区域时，`--muted` 标签几乎不可见）。

**规则：透明度（玻璃）模式必须给每张卡片加一层「本地面纱」，
强度与卡片透明度挂钩 —— 这样对比度就与「卡片所处位置」解耦。**

另外面纱**不能做成上浅下深的大落差**：按最坏情况（最亮像素）采样时，
梯度顶端就是短板。实测顶端 `.55` 配合 `xp=0.75` 只有约 `0.41` 的有效强度，
压不住白底（背景仍有 `rgb(108,108,108)`）。改成「整体就很深、只留很小的纵向渐变」
（`.86 → .94`）才达标。

### 10. 验证脚本要用**真实状态机**，别直接改 CSS 变量

第一版可读性测试直接 `document.documentElement.style.setProperty("--card-alpha", "0.25")`，
但页面的 `SkinManager.onChange` 会立刻把它**回写覆盖**。
于是测试实际跑在「无壁纸 + 非沉浸」的旧状态上，却以为自己测的是沉浸态 ——
结论完全失真（量出「整片 L≈175 的灰块」「对比度 1.1」这类假数据）。

**规则：测试必须通过组件暴露的接口驱动状态**（本项目在 `index.html` 里挂了
`window.qld.skin`），改完等一帧再采样。

### 11. 这个构建的 puppeteer-core 会丢掉 `DOMRect` 的 `width`/`height`

`page.evaluate(() => el.getBoundingClientRect())` 直接返回时，
`width`/`height` 是 `DOMRect.prototype` 上的 getter，序列化后**丢失** →
`er.h === undefined` → 采样坐标算成 `NaN` → 采到卡片外的亮壁纸 →
对比度假性掉到 1.1（一条本来不存在的「卡片看不清」警报）。

**规则：永远显式摊平 —— `const box = r => ({x:r.x, y:r.y, w:r.width, h:r.height})`。**

### 12. 测量前先禁用 HTTP 缓存

`express.static` 会发 `ETag` / `Last-Modified`，组件 JS 走 304 复用旧副本。
实测改了 `stat-cards.js` 的公式后重跑，量出来的仍是**上一次的旧值**，
差点误判成「改动没生效」。加 `page.setCacheEnabled(false)` 后一致。

**规则：任何「改代码 → 跑验证」的自动化脚本都要禁用缓存。**

---

## 验证方式

本组件的所有性能数据均由 puppeteer 驱动真实 Chrome 采集，包含：

- DOM 节点数：`document.querySelectorAll` 实时计数
- FPS：`requestAnimationFrame` 帧计数
- 功能断言：状态纯度为 100%、滚动到底末行 idx 正确、未读计数累积、指纹去重生效等
- 视觉校验：截图人工复核（曾据此发现上述「浅底浅字」与「空态浮层」两个 bug）

> 单元测试抓不到「颜色对比度」和「容器高度为 0」这类问题，
> **断言 CSS 计算值（`getComputedStyle`）比断言 DOM 结构更有效。**
>
> 但 `getComputedStyle` 仍只返回**声明值**，不反映 `blur` + 壁纸 + 面纱叠加后的真实观感。
> 想拿到可信的对比度结论，必须**解码截图像素**、在文字附近采样实际背景色 ——
> 本项目最关键的几个 bug（卡片全透明、文字看不清、光晕泄漏成浅色方块）
> **全都是靠截图像素采样 / 人工复核发现的，DOM 与 CSS 断言一个都没抓到**。

采样两个具体的坑（都踩过）：

1. **别在文字左右横向偏移采样**：标签行高只有 ~16px，`dx = ±3..6px` 仍在字形上，
   对比度恒等于 1。要取**垂直方向**偏离文字行中心的像素。
2. **采样点要用 `clamp` 夹在卡片边界内**：否则会采到卡片外的壁纸或描边上，
   得到「卡片是白的」这种荒谬结论。
