# dsh-lecture-forge

[![CI](https://github.com/BowenYu123/dsh-lecture-forge-/actions/workflows/ci.yml/badge.svg)](https://github.com/BowenYu123/dsh-lecture-forge-/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

把**论文、教材、讲义、网页或扫描件**变成一份**全覆盖、可追溯、带推导、配图与可运行代码**的学习讲义，并导出 PDF / HTML / ipynb / Markdown。

面向数学、物理、计算机、工程等需要公式推导、作图、算法或数值实验的学科。

## 它解决什么问题

直接让模型“总结一篇论文”通常会丢掉推导、跳过细节、编造引用。LectureForge 把这件事做成一条有账本、有门槛的流水线：

- **全覆盖**：素材被切成块，每块必须在讲义里有归宿（`covered` / `merged` / `blocked`），审计逐块核对，不允许“摘要代替覆盖”。
- **可追溯**：正文保留 `[S01, p.3]` 这样的来源标记，审计检查每个“已覆盖”块在对应章节确实有同源同页标记。
- **补模糊**：原文省略的推导、没定义清楚的符号、隐含的适用条件，用 `[!CLARIFY]` / `[!DERIVE]` 标注补全，并要求与账本双向对应。
- **真配图**：函数图用 numpy 精确绘制（可复现），素材图按页裁切，示意图手写 SVG，外部图必须登记许可与作者。
- **真运行**：Notebook 每个代码单元真实执行，失败会阻止交付；数值结论可用 `lecture_verify` 复核。
- **真审计**：`lecture_audit` 是确定性代码检查（不是模型自评），`level=full` 还检查 PDF/QA 页图与独立复核记录。

## 安装

本插件是 Host-only bundle，无前端、无 npm 依赖（运行时资产已内置）。

```bash
# 在 DSH 中（需要审批）；把 target 换成插件目录的真实路径
# macOS / Linux
plugin_manager install_bundle target="/Users/<you>/dsh-lecture-forge"
# Windows
plugin_manager install_bundle target="C:\ds_workzone\讲义生成插件"
```

安装后：

- 工具：`lecture_init`、`lecture_ingest`、`lecture_ledger`、`lecture_figure`、`lecture_build`、`lecture_verify`、`lecture_audit`
- 技能：`lecture-forge`（模型在“生成讲义/学习材料”类任务中自动调用）

用 `cordis_inspect_query` 的 `Tool/listTools` 与技能列表确认注册成功；替换已安装版本后需要重启 DSH。

## 快速开始

对 Agent 说：

> 用这篇论文和这份讲义给我做一份本科二年级能看懂的讲义，要推导和练习，输出 PDF 和 ipynb：
> - `materials/paper.pdf`
> - `materials/notes.md`

Agent 会：

1. `lecture_init` 建 `.lecture/` 项目；
2. `lecture_ingest` 摄取每个素材，报告块数、低文本页、警告；
3. 读素材、规划章节，写 `.lecture/lecture.md`；
4. 用 `lecture_figure` 配图，`lecture_verify` 验证推导；
5. `lecture_ledger claim-batch` 回填覆盖；
6. `lecture_build` 导出，读 `out/qa/` 页图做视觉检查；
7. 独立 subagent 语义复核 → `lecture_audit record-review` → `lecture_audit level=full` 通过后交付。

产物在 `<项目>/out/`：

```
out/lecture.pdf
out/lecture.ipynb        # 已执行，含真实输出
out/lecture.html         # 自包含，可直接分享/打印
out/lecture.md
out/qa/page-0001.png …   # 视觉检查页图
out/build-report.json    # 覆盖统计、页数、Notebook 执行情况
out/lecture_helpers/     # notebook 用的 lecturekit（numpy 绘图等）
out/assets/              # 图片
```

## 工具

### `lecture_init`

创建项目：标题、学习目标、学科、学习者水平、语言、深度（`brief|standard|deep`）、输出格式（`pdf|html|ipynb|md`）、必须补充的内容桶、每节练习数。幂等。

### `lecture_ingest`

- `action: "source"`（缺省）：摄取 PDF / DOCX / PPTX / Markdown / HTML / 纯文本 / URL。返回 `sourceId`、`blockCount`、`structure`、`lowTextPages`、`visionQueue`、`warnings`。
- `action: "attach-ocr"`：把扫描页/图片页的视觉转写写回素材（`kind: "ocr"`），之后必须 claim + `reviewed`。

PDF 文本用内置 pypdf 抽取；扫描页按 `lowTextCharThreshold` 自动识别，用 LibreOffice Kit（pdfium）渲染成 PNG 交给 Agent 视觉识别。

### `lecture_ledger`

覆盖账本：`list` / `next`（取未覆盖块 + 摘要）/ `claim` / `claim-batch` / `stats` / `reviewed`。

claim 字段：`blockId`、`status`（`covered|merged|blocked|pending`）、`sections[]`、`kinds[]`（`exposition|clarification|derivation|example|verification|exercise|solution`）、`mergeInto`、`reason`。

### `lecture_figure`

- `extract`：从 PDF 某页按 `rect`（0–1 相对坐标）裁图并登记来源；
- `plot`：用 numpy 精确绘图（`line|scatter|parametric|vector_field|heatmap|contour`），记录 spec 可复现；
- `svg`：登记手写示意图（自动清洗 script/事件属性）；
- `url`：下载外部图片，严格模式下必须给 `license` + `author`；
- `list`：查看已登记图片与可粘贴的 Markdown 行。

### `lecture_build`

导出 `pdf` / `html` / `ipynb` / `md`。会先拒绝：未映射素材块、公式解析错误、未登记图片（`allowIncomplete:true` 仅用于草稿预览）。PDF 用无头浏览器（Windows 的 Edge/Chrome，macOS 的 Chrome/Chromium）打印，随后用 LibreOffice Kit 渲染 QA 页图。

### `lecture_verify`

- `action: "python"`：跑校验脚本（自动注入插件 Python 路径与 `lecturekit`），约定 stdout 最后一行 `{"checks":[{"name":"…","ok":true,"detail":"…"}]}`；
- `action: "notebook"`：重新执行 `out/lecture.ipynb` 并报告失败单元。

### `lecture_audit`

确定性审计：覆盖、章节 id、来源标记、澄清标注双向对应、补充桶、图片登记与来源、交叉引用、公式、扫描页复核；`level=full` 再加 PDF/QA/Notebook/独立复核记录。`action: "record-review"` 写入 `.lecture/review.json`。

错误码与修法见技能 `lecture-forge`。

## Markdown 方言

```markdown
## Euler–Lagrange 方程 {#sec-euler-lagrange}

设 $F(x,y,y')$ 关于 $y'$ 连续可微 [S01, p.12]。

$$ \frac{\partial F}{\partial y} - \frac{d}{dx}\frac{\partial F}{\partial y'} = 0 $$ {#eq-5}

> [!CLARIFY] 原文省略了边界项：分部积分给出 … [S01, p.12]

> [!DERIVE] 补全推导
> 取 $y_\epsilon = y + \epsilon\eta$，对 $\epsilon$ 在 $0$ 处求导 …

![图 1：泛函的变分](assets/fig-001.svg){#fig-1 width=70%}

由 [@eq-5] 可得 [@fig-1] 的极值条件。
```

- 标题建议显式写全局唯一、kebab-case 的 `{#sec-…}`；缺省会自动生成 `sec-N`，但账本 claim 请用显式 id；
- 标注块：`[!CLARIFY]` `[!NOTE]` `[!WARN]` `[!DERIVE]` `[!EXAMPLE]` `[!CHECK]`；
- 来源标记：`[S01, p.3]` / `[S01, §2.4]`（本版本不支持视频时间标记）；
- 交叉引用：`[@fig-1]` / `[@sec-…]` / `[@eq-5]`；
- 公式编号：`$$ … $$ {#eq-5}`。

## 配置

`cordis.patch.yml` 里可传 `config`：

```yaml
- insert:
    - id: dsh-lecture-forge
      name: '@local/dsh-lecture-forge'
      config:
        defaultLanguage: zh
        strictLicensing: true
        qaPages: 8
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `pythonPath` | 自动 | 需要 numpy + Pillow + pypdf（插件自带 pypdf） |
| `chromiumPath` | 自动 | Edge/Chrome，用于 HTML→PDF |
| `libreOfficeKitCli` | 自动 | PDF 栅格化与页数检查 |
| `maxPages` | 400 | 单个 PDF 最大页数 |
| `maxFileBytes` | 200MB | 单个素材最大体积 |
| `lowTextCharThreshold` | 80 | 低于该字符数的页视为扫描页 |
| `visionQueueLimit` | 5 | 一次返回的待识别页数 |
| `strictLicensing` | true | 外部图片必须 license+author |
| `defaultLanguage` | zh | 讲义默认语言 |
| `buildTimeoutMs` | 180000 | 单次构建超时 |
| `cellTimeoutMs` | 60000 | Notebook 单元超时 |
| `notebookTimeoutMs` | 600000 | Notebook 总超时 |
| `qaPages` | 6 | QA 页图数量 |
| `qaDpi` | 144 | QA 页图分辨率 |
| `keepRawSources` | true | 保留原始素材副本 |

运行时自动探测：DSH 自带 Python（含 numpy/Pillow）、无头浏览器（Windows Edge/Chrome，macOS/Linux Chrome/Chromium）、LibreOffice Kit。缺什么会在 `lecture_init` 的 warnings 里说明。

## 数据与目录

```
<project>/
  .lecture/
    project.json     # 项目配置
    lecture.md       # 讲义正文（源文件）
    ledger.json      # 覆盖账本
    figures.json     # 图片登记
    sources/S01.json # 规范化素材块
    assets/          # 图片文件
    raw/             # 原始素材副本
    build/           # 中间产物与构建报告
    review.json      # 独立复核记录
  out/               # 交付物
```

所有路径都相对**会话工作区**解析；输入路径限制在工作区、用户主目录、临时目录内。

## 已知限制

- 不支持视频/音频素材（参考技能里的时间标记仅保留语法，审计会报 `UNSUPPORTED_TIME_MARKER`）。
- v1 不导出 DOCX/PPTX；渲染器有注册表，后续可扩展。
- 没有图像生成模型：概念示意图由 Agent 写 SVG，函数图由 numpy 绘制。
- 扫描页依赖 Agent 视觉识别（`read_image` / `modlens_read_image`），识别质量决定覆盖质量；低置信页必须人工/视觉复核。
- PDF 由无头浏览器打印（Windows 用 Edge/Chrome，macOS 用 Chrome/Chromium），分页与字体取决于所用浏览器与本机字体；中文需要系统字体。

## 开发

```bash
node --test --test-timeout=180000 "test/**/*.test.mjs"
```

目录：

```
index.js                 插件入口（注册工具与技能）
lib/
  config.mjs             配置校验与运行时探测
  paths.mjs              路径、原子写、哈希、围栏
  runner.mjs             子进程（超时/中止/杀进程树）
  projects.mjs           项目与素材、覆盖率
  ledger.mjs             账本状态机
  audit.mjs              确定性审计
  assets.mjs             图片识别/校验/登记
  ingest/                PDF/DOCX/PPTX/HTML/MD/URL 摄取
  render/                KaTeX、Markdown、HTML、PDF、ipynb
  tools/                 7 个工具
py/
  extract_pdf.py         pypdf 文本/图抽取
  crop_image.py          页内裁图
  run_plot.py            绘图入口
  lecturekit/            notebook 执行器与 numpy 绘图库
assets/
  css/                   讲义与打印样式
  vendor/                KaTeX、markdown-it、pypdf（内置）
skills/lecture-forge/    技能正文与参考资料
```

## 贡献

欢迎提交 issue 与 pull request。改动后请先跑：

```bash
npm test
```

CI 会在 macOS 与 Ubuntu 上运行同一套测试（需要 numpy 的用例在缺少 numpy 时自动跳过）。

## 许可

本项目以 [MIT License](LICENSE) 开源，Copyright (c) 2026 Bowen Yu。

内置第三方资产各自保留原许可：KaTeX（MIT）、markdown-it（MIT）、pypdf（BSD-3-Clause），见各目录 LICENSE。

## 参考技能

`lecture-forge` 技能的流程与约束源自用户的 LectureForge 规范：全覆盖、可追溯、区分原创与补充、代码可运行、审计闭环。
