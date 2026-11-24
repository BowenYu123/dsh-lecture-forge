# 讲义 Markdown 方言（LectureForge）

本插件只认这一套方言：**普通 GFM Markdown + 六种扩展**。`lecture_build` 把 `lecture.md` 渲染成 HTML/PDF/ipynb，审计器（`lecture_audit`）按同一套规则逐行检查。写作时请对照本文件，不要发明新语法。

## 1. 标题与章节 id

```markdown
# 讲义标题
## 1. 引言 {#sec-intro}
### 1.1 为什么需要平均场 {#sec-meanfield}
```

- 末尾的 `{#sec-xxx}` 是**章节 id**，`lecture_ledger claim` 用它指定素材块归属。
- 不写 id 时自动生成 `sec-1`、`sec-2`……（避开已有显式 id）。
- 显式 id 建议用 `sec-` 前缀、小写字母/数字/连字符，正文里通过 `[@sec-intro]` 引用。
- 标题层级只用于排版；**归属只看 claim 的 sections**，不自动按标题嵌套。

## 2. 数学公式

```markdown
行内：平均值为 $\bar f=\frac{1}{3}$。

展示（带编号）：
$$
\bar f=\frac{1}{b-a}\int_a^b f(x)\,dx
$$ {#eq-mean}
```

- 支持 `$...$` 行内、`$$...$$` 展示；公式内可跨行，但**行内公式不能跨空行**，且结尾 `$` 前不能是空格。
- 展示公式在结束的 `$$` 后写 `{#eq-xxx}` 才会编号，编号为 `#eq-` 之后的部分（上例显示 `(mean)`；想显示 `(1)` 就写 `{#eq-1}`）。
- 公式解析失败会让 `lecture_build` 报 `MATH_ERRORS`、审计报 `MATH_ERROR`——**构建前必须先清空**。
- 公式不要放进代码围栏（会被当成代码原样显示）。

## 3. 来源标记（可追溯性核心）

```markdown
第一页介绍研究背景与动机 [S01, p.1]。
第 2.4 节给出边界条件 [S01, §2.4]。
视频第 12 分 31 秒演示实验 [V01, 00:12:31]。
```

- 格式：`[<来源号>, <定位>]`，来源号是 `S01`/`S02`…（`lecture_ingest` 返回的 sourceId），定位可以是：
  - `p.3` / `pp.3-4`（分页素材，页码必须在范围内）；
  - `§2.4`（文档/网页的小节）；
  - `00:12:31`（时间戳，保留原始形式，需要配置时间来源）。
- 每个被 `covered` 的素材块，**必须在其所属章节的行范围内**出现至少一个同来源、同页（或同节）的标记，否则审计报 `MISSING_SOURCE_MARKER`。
- 标记必须与来源号匹配（`S99` → `UNKNOWN_SOURCE_MARKER`），不能写进代码围栏或公式。
- 同一段内容综合多个块时，逐个标：`…… [S01, p.3][S01, p.5]`。

## 4. 标注块（补充解释的载体）

```markdown
> [!CLARIFY] 原素材省略的推导
> 原文直接写"由此可得"，这里补全三步：
> 1. 对 $x$ 求偏导；
> 2. 令偏导为零；
> 3. 得到驻点条件。

> [!DERIVE] 从能量泛函到 Euler–Lagrange 方程
> ...

> [!EXAMPLE] 最速降线
> ...

> [!WARN] 记号陷阱
> 这里的 $\frac{df}{dx}$ 是全导数，不是偏导数。

> [!CHECK] 数值验证
> ```python
> import numpy as np
> print(np.trapz(np.linspace(0,1,101)**2, np.linspace(0,1,101)))
> ```

> [!NOTE] 直觉
> ...
```

- 六种类型：`NOTE`（补充说明）、`WARN`（常见错误/条件）、`CLARIFY`（澄清原文模糊处）、`DERIVE`（补全省略推导）、`EXAMPLE`（例题）、`CHECK`（计算/代码验证）。
- 标注块用 `>` 引用语法，`> [!类型] 标题` 开始，后续 `>` 行属于块；空行 + 下一标注块或普通行结束。
- **`[!CLARIFY]` 与账本强绑定**：某块 claim 的 kinds 含 `clarification` 时，其所属章节内必须有一个带**同来源同页标记**的 `[!CLARIFY]` 块；反过来，没有对应 clarification 块的 `[!CLARIFY]` 也会报 `CLARIFY_WITHOUT_BLOCK`。审计做双向检查。
- `[!CHECK]` 里的 ```` ```python ```` 围栏会被 `lecture_build` 收进 notebook 并真实执行；执行失败会让审计报 `NOTEBOOK_FAILED`。
- `[!DERIVE]`/`[!EXAMPLE]` 里同样可以放公式、编号和图。

## 5. 图

```markdown
![正弦与余弦](assets/fig-001.svg){#fig-001 width=80%}
```

- 路径固定 `assets/<文件名>`；`lecture_figure` 返回的 `markdown` 字段可直接粘贴。
- `{#fig-001}` 是图锚点：**必须与 figures.json 里的 assetId 一致**（`fig-001` 对应 `assets/fig-001.svg|png`），否则审计报 `FIGURE_UNREGISTERED`。
- `width=` 只接受百分比（`60%`/`80%`），缺省 80%。
- 图注写在 `[]` 里，渲染为「图 N：图注」，编号按出现顺序自动分配。
- 图必须来自 `lecture_figure`（extract/plot/svg/url 四类），并在正文真实被引用；未被引用会得到 `FIGURE_UNUSED` 警告。
- 绘图优先用 `lecture_figure plot`（SVG、可复现、可进 ipynb），而不是贴位图。

## 6. 交叉引用

```markdown
由式 [@eq-mean] 与图 [@fig-001] 可知，见 [@sec-meanfield]。
```

- 引用目标必须是已存在的章节 id、公式 id 或图锚点；断链 → 审计 `BROKEN_REF`、渲染显示为断链样式。
- 渲染后自动变成「图 1」「式 (mean)」「§1」这类带链接文本。
- 不要在代码围栏里写 `[@...]`（原样保留）。

## 7. 代码围栏

- 标准三反引号围栏；语言标注 `python`/`py`/`python3`/`ipython` 的围栏会进 notebook 并执行。
- 其它语言（`bash`、`json`、`text`）只做排版，不执行。
- 围栏内容不参与标题/公式/标记/图/引用的解析。
- 需要真实数值验证的推导，用 `[!CHECK]` + python 围栏，并在 `lecture_verify` 里跑一遍。

## 8. 表格与其他

- GFM 表格、列表、引用、加粗斜体照常使用。
- 原始 HTML 被关闭（`html:false`），请用 Markdown 表达；需要特殊排版时用标注块。
- 页眉/页脚、封面、目录、图目录、附录（未覆盖来源、覆盖统计、复核记录）由渲染器自动生成，**不要在 lecture.md 里手写**。

## 9. 与审计的对应关系（速查）

| 写法 | 审计检查 |
| --- | --- |
| `{#sec-x}` | 章节必须存在、唯一；claim 引用的 section 必须在这里 |
| `[S01, p.3]` | 来源存在、页码在范围、位于 covered 块所属章节内 |
| `[!CLARIFY]` | 与 clarification 块双向对应，且带同源同页标记 |
| `![...](assets/fig-001.svg){#fig-001}` | 图已登记、文件存在、来源/许可齐全 |
| `[@fig-001]` | 目标存在（图锚点/章节/公式） |
| `$$...$$ {#eq-1}` | KaTeX 无解析错误、编号唯一 |
| ```` ```python ````（在 `[!CHECK]` 内） | notebook 执行成功、无失败单元 |

写作顺序建议：先只用标题 + 段落 + 来源标记搭骨架 → `lecture_ledger claim` 回填 → 再补 `[!CLARIFY]`/`[!DERIVE]`/例题/练习 → 最后配图、写 `[!CHECK]` 验证 → `lecture_build` → `lecture_audit`。
