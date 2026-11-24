// LectureForge — 自包含 HTML 讲义文档。
//
// 输出是单个可直接离线打开的 HTML 文件：
//   - <head> 内联 KaTeX 样式（字体以 base64 内嵌）+ lecture.css + print.css
//   - 封面（标题/元信息/素材清单）、目录、图目录
//   - 正文 bodyHtml
//   - 附录 A 未覆盖来源、附录 B 素材覆盖统计、附录 C 复核说明
//   - 页脚；打印分页/页码交给 print.css 的 @page 规则
// 图片默认保留相对路径（调用方可把 assets/ 一并复制）；若 extras.assetDataUrls 提供了
// data URL，则就地内联，使单文件完全自包含。
import fs from 'node:fs'
import path from 'node:path'
import { ASSETS_DIR } from '../paths.mjs'
import { katexCss, escapeHtml, escapeAttr } from './math.mjs'

const CSS_CACHE = new Map()

function readCss(name) {
  if (CSS_CACHE.has(name)) return CSS_CACHE.get(name)
  let content = ''
  try {
    content = fs.readFileSync(path.join(ASSETS_DIR, 'css', name), 'utf8')
  } catch {
    content = ''
  }
  CSS_CACHE.set(name, content)
  return content
}

const LANGUAGE_LABELS = {
  zh: '中文',
  'zh-cn': '中文',
  'zh-tw': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
}

const LEVEL_LABELS = {
  intro: '入门',
  beginner: '入门',
  basic: '基础',
  standard: '标准',
  intermediate: '进阶',
  advanced: '进阶',
  deep: '深入',
  expert: '专家',
}

function languageLabel(value) {
  const key = String(value ?? '').trim().toLowerCase()
  return LANGUAGE_LABELS[key] ?? (String(value ?? '').trim() || '—')
}

function levelLabel(value) {
  const key = String(value ?? '').trim().toLowerCase()
  return LEVEL_LABELS[key] ?? (String(value ?? '').trim() || '—')
}

function text(value, fallback = '—') {
  if (value == null) return fallback
  const result = String(value).trim()
  return result || fallback
}

function formatWhen(value) {
  const date = value ? new Date(value) : new Date()
  if (Number.isNaN(date.getTime())) return text(value)
  const pad = (part) => String(part).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

function stripInlineMarkup(value) {
  return String(value ?? '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
}

function cleanCaption(caption) {
  return String(caption ?? '')
    .replace(/^(?:图|Figure|Fig\.?)\s*\d+\s*[:：.、\-–—]?\s*/i, '')
    .trim()
}

function pageCount(source) {
  if (typeof source?.pages === 'number') return source.pages
  if (source?.pages && typeof source.pages === 'object') return Object.keys(source.pages).length
  return null
}

function figureAnchor(figure, index) {
  return figure?.id ?? figure?.assetId ?? `fig-${index + 1}`
}

/**
 * 生成完整 HTML 文档。
 * @param {{
 *   project: object,
 *   analysis: object,
 *   bodyHtml: string,
 *   extras?: {
 *     sources?: Array<object>,
 *     coverage?: object|null,
 *     blockedBlocks?: Array<{blockId?: string, sourceId?: string, page?: string|number, text?: string}>,
 *     reviewNotes?: string[],
 *     figures?: Array<object>,
 *     assetDataUrls?: Record<string, string>,
 *     generatedAt?: string,
 *   },
 *   css?: {lecture?: string, print?: string},
 * }} input
 * @returns {{html: string, warnings: string[]}}
 */
export function renderHtmlDocument({ project, analysis, bodyHtml, extras = {}, css = {} }) {
  const warnings = []
  const safeExtras = extras && typeof extras === 'object' ? extras : {}
  const safeCss = css && typeof css === 'object' ? css : {}
  const title = text(project?.title, '未命名讲义')
  const isEnglish = String(project?.language ?? 'zh').toLowerCase().startsWith('en')
  const label = isEnglish ? { figure: 'Figure', equation: 'Equation' } : { figure: '图', equation: '式' }
  const generatedAt = formatWhen(safeExtras.generatedAt)

  const lectureCss = typeof safeCss.lecture === 'string' ? safeCss.lecture : readCss('lecture.css')
  const printCss = typeof safeCss.print === 'string' ? safeCss.print : readCss('print.css')
  const mathCss = katexCss({ embedFonts: true })

  const body = inlinedBody(String(bodyHtml ?? ''), safeExtras.assetDataUrls, warnings)

  const cover = renderCover({ project, extras: safeExtras, title, generatedAt })
  const toc = renderToc(analysis?.sections ?? analysis?.headings ?? [])
  const figureToc = renderFigureToc(analysis?.figures ?? safeExtras.figures ?? [], label)
  const appendixA = renderBlocked(safeExtras.blockedBlocks ?? [])
  const appendixB = renderCoverage(safeExtras.coverage ?? null)
  const appendixC = renderReviewNotes(safeExtras.reviewNotes ?? [])

  const html = `<!DOCTYPE html>
<html lang="${escapeAttr(documentLanguage(project?.language))}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="LectureForge">
<meta name="lecture-forge:title" content="${escapeAttr(title)}">
<meta name="lecture-forge:generated-at" content="${escapeAttr(generatedAt)}">
<title>${escapeHtml(title)}</title>
<style id="katex-css">${mathCss}</style>
<style id="lecture-css">${lectureCss}</style>
<style id="print-css" media="print">${printCss}</style>
</head>
<body>
<div class="lf-front">
${cover}
${toc}
${figureToc}
</div>
<main class="lf-body">
${body}
</main>
<div class="lf-appendix-wrap">
${appendixA}
${appendixB}
${appendixC}
</div>
<footer class="lf-footer">
<span class="lf-footer-brand">LectureForge · ${escapeHtml(title)}</span>
<span class="lf-footer-page"></span>
</footer>
</body>
</html>`

  return { html, warnings }
}

function documentLanguage(language) {
  const key = String(language ?? '').trim().toLowerCase()
  if (key.startsWith('en')) return 'en'
  if (key.startsWith('zh-tw') || key.startsWith('zh-hant')) return 'zh-Hant'
  return 'zh-CN'
}

function renderCover({ project, extras, title, generatedAt }) {
  const sources = Array.isArray(extras.sources) ? extras.sources : []
  const metaRows = [
    ['主题', text(project?.subject)],
    ['学习者', levelLabel(project?.learnerLevel)],
    ['语言', languageLabel(project?.language)],
    ['深度', levelLabel(project?.depth)],
  ]
  const goal = String(project?.goal ?? '').trim()
  const subtitle = goal || '由论文 / 教材 / 讲义整理的学习讲义'
  const sourceRows = sources
    .map((source) => {
      const pages = pageCount(source)
      return (
        '<tr>' +
        `<td class="col-id">${escapeHtml(text(source?.sourceId))}</td>` +
        `<td>${escapeHtml(text(source?.label ?? source?.title))}</td>` +
        `<td class="col-kind">${escapeHtml(text(source?.kind, '—'))}</td>` +
        `<td class="col-num">${pages == null ? '—' : escapeHtml(String(pages))}</td>` +
        `<td class="col-num">${source?.blocks == null ? '—' : escapeHtml(String(source.blocks))}</td>` +
        '</tr>'
      )
    })
    .join('\n')

  const sourcesSection = sources.length
    ? `<section class="lf-cover-sources">
<p class="lf-section-title">素材清单</p>
<table class="lf-table lf-table-sources">
<thead><tr><th>来源</th><th>标题</th><th>类型</th><th>页数</th><th>块数</th></tr></thead>
<tbody>
${sourceRows}
</tbody>
</table>
</section>`
    : `<section class="lf-cover-sources"><p class="lf-section-title">素材清单</p><p class="lf-empty">未登记素材。</p></section>`

  return `<header class="lf-cover">
<p class="lf-kicker">LectureForge 讲义</p>
<h1 class="lf-title">${escapeHtml(title)}</h1>
<p class="lf-subtitle">${escapeHtml(subtitle)}</p>
<dl class="lf-meta">
${metaRows.map(([term, value]) => `<div class="lf-meta-row"><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('\n')}
</dl>
<p class="lf-generated">生成时间：<time datetime="${escapeAttr(generatedAt)}">${escapeHtml(generatedAt)}</time></p>
${sourcesSection}
</header>`
}

function renderToc(sections) {
  const entries = (Array.isArray(sections) ? sections : []).filter((section) => Number(section?.level) >= 2)
  if (entries.length === 0) {
    return `<nav class="lf-toc" aria-label="目录"><h2 class="lf-toc-title">目录</h2><p class="lf-empty">正文没有二级及以下标题。</p></nav>`
  }
  const rows = entries
    .map((section) => {
      const level = Math.min(6, Math.max(2, Number(section.level) || 2))
      return (
        `<li class="lf-toc-item lf-toc-level-${level}">` +
        `<a class="toc-link" href="#${escapeAttr(section.id)}">${escapeHtml(stripInlineMarkup(section.title) || section.id)}</a>` +
        '</li>'
      )
    })
    .join('\n')
  return `<nav class="lf-toc" aria-label="目录">
<h2 class="lf-toc-title">目录</h2>
<ol class="lf-toc-list">
${rows}
</ol>
</nav>`
}

function renderFigureToc(figures, label) {
  const list = (Array.isArray(figures) ? figures : []).filter((figure) => figure && typeof figure === 'object')
  if (list.length === 0) {
    return `<nav class="lf-figures" aria-label="图目录"><h2 class="lf-figures-title">图目录</h2><p class="lf-empty">正文没有图片。</p></nav>`
  }
  const rows = list
    .map((figure, index) => {
      const caption = cleanCaption(figure.caption)
      const name = caption ? `${label.figure} ${index + 1}　${caption}` : `${label.figure} ${index + 1}`
      return (
        '<li class="lf-figure-item">' +
        `<a class="toc-link" href="#${escapeAttr(figureAnchor(figure, index))}">${escapeHtml(name)}</a>` +
        '</li>'
      )
    })
    .join('\n')
  return `<nav class="lf-figures" aria-label="图目录">
<h2 class="lf-figures-title">图目录</h2>
<ol class="lf-figure-list">
${rows}
</ol>
</nav>`
}

function renderBlocked(blocks) {
  const list = (Array.isArray(blocks) ? blocks : []).filter((block) => block && typeof block === 'object')
  if (list.length === 0) {
    return `<section class="lf-appendix" id="appendix-a">
<h2>附录 A　未覆盖来源</h2>
<p class="lf-empty">没有未覆盖的素材块。</p>
</section>`
  }
  const rows = list
    .map((block) => {
      const page = block.page ?? block.pages ?? '—'
      return (
        '<tr>' +
        `<td class="col-id">${escapeHtml(text(block.blockId))}</td>` +
        `<td class="col-id">${escapeHtml(text(block.sourceId))}</td>` +
        `<td class="col-num">${escapeHtml(text(page))}</td>` +
        `<td class="col-text">${escapeHtml(text(block.text, ''))}</td>` +
        '</tr>'
      )
    })
    .join('\n')
  return `<section class="lf-appendix" id="appendix-a">
<h2>附录 A　未覆盖来源</h2>
<p class="lf-note">以下素材块未进入正文（被跳过或无法解析），列出以便复核。</p>
<table class="lf-table lf-table-blocked">
<thead><tr><th>块 ID</th><th>来源</th><th>页/位置</th><th>内容</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</section>`
}

function renderCoverage(coverage) {
  if (!coverage || typeof coverage !== 'object') {
    return `<section class="lf-appendix" id="appendix-b">
<h2>附录 B　素材覆盖统计</h2>
<p class="lf-empty">没有覆盖统计数据。</p>
</section>`
  }
  const total = numberOrZero(coverage.total)
  const covered = numberOrZero(coverage.covered)
  const merged = numberOrZero(coverage.merged)
  const blocked = numberOrZero(coverage.blocked)
  const pending = numberOrZero(coverage.pending)
  const percent = coverage.percent == null ? (total > 0 ? Math.round((covered + merged) / total * 100) : 0) : numberOrZero(coverage.percent)
  const summary = `<p class="lf-coverage-summary">共 <strong>${total}</strong> 块素材，已覆盖 <strong>${covered}</strong> 块，合并 <strong>${merged}</strong> 块，未覆盖 <strong>${blocked}</strong> 块${
    pending > 0 ? `，待处理 <strong>${pending}</strong> 块` : ''
  }，覆盖率 <strong>${percent}%</strong>。</p>`

  const perSource = Array.isArray(coverage.perSource) ? coverage.perSource : []
  if (perSource.length === 0) {
    return `<section class="lf-appendix" id="appendix-b">
<h2>附录 B　素材覆盖统计</h2>
${summary}
</section>`
  }
  const rows = perSource
    .map((source) => {
      const blocks = numberOrZero(source.blocks)
      const sourcePercent = source.percent == null
        ? blocks > 0
          ? Math.round((numberOrZero(source.covered) + numberOrZero(source.merged)) / blocks * 100)
          : 100
        : numberOrZero(source.percent)
      return (
        '<tr>' +
        `<td class="col-id">${escapeHtml(text(source.sourceId))}</td>` +
        `<td>${escapeHtml(text(source.label ?? source.title))}</td>` +
        `<td class="col-num">${blocks}</td>` +
        `<td class="col-num">${numberOrZero(source.covered)}</td>` +
        `<td class="col-num">${numberOrZero(source.merged)}</td>` +
        `<td class="col-num">${numberOrZero(source.blocked)}</td>` +
        `<td class="col-num">${numberOrZero(source.pending)}</td>` +
        `<td class="col-num">${sourcePercent}%</td>` +
        '</tr>'
      )
    })
    .join('\n')
  return `<section class="lf-appendix" id="appendix-b">
<h2>附录 B　素材覆盖统计</h2>
${summary}
<table class="lf-table lf-table-coverage">
<thead><tr><th>来源</th><th>标题</th><th>块数</th><th>已覆盖</th><th>合并</th><th>未覆盖</th><th>待处理</th><th>覆盖率</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</section>`
}

function renderReviewNotes(notes) {
  const list = (Array.isArray(notes) ? notes : []).filter((note) => String(note ?? '').trim())
  if (list.length === 0) {
    return `<section class="lf-appendix" id="appendix-c">
<h2>附录 C　复核说明</h2>
<p class="lf-empty">没有额外的复核说明。</p>
</section>`
  }
  const items = list.map((note) => `<li>${escapeHtml(String(note))}</li>`).join('\n')
  return `<section class="lf-appendix" id="appendix-c">
<h2>附录 C　复核说明</h2>
<ul class="lf-review-notes">
${items}
</ul>
</section>`
}

function numberOrZero(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

/** 把 bodyHtml 中的 src="assets/..." 换成调用方提供的 data URL。 */
function inlinedBody(html, assetDataUrls, warnings) {
  if (!assetDataUrls || typeof assetDataUrls !== 'object') return html
  let missing = 0
  const output = html.replace(/(<img\b[^>]*?\bsrc=")([^"]+)(")/g, (match, prefix, src, suffix) => {
    const file = src.split(/[\\/]/).pop() ?? src
    const assetId = file.replace(/\.[^.]+$/, '')
    const dataUrl = assetDataUrls[assetId] ?? assetDataUrls[src] ?? assetDataUrls[`assets/${file}`]
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
      return prefix + dataUrl + suffix
    }
    missing += 1
    return match
  })
  if (missing > 0) {
    warnings.push(`有 ${missing} 张图片缺少 data URL，已保留相对路径（请随产物复制 assets/ 目录）。`)
  }
  return output
}
