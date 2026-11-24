// LectureForge — Markdown 方言解析（纯文本扫描）与渲染。
//
// 方言：
//   ## 2.1 极限的定义 {#sec-2-1}        标题 + 显式 id（缺省自动 sec-<n>）
//   $...$ / $$...$$                     KaTeX 数学（可跨行）；$$...$$ {#eq-5} 编号
//   > [!CLARIFY] 标题 ...              标注块（NOTE/WARN/CLARIFY/DERIVE/EXAMPLE/CHECK）
//   ![图 3](assets/fig-003.svg){#fig-3 width=70%}   图 + 属性
//   [@fig-3] [@sec-2-1] [@eq-5]         交叉引用
//   [S01, p.3] [S01, §2.4] [V01, 00:12:31]  来源标记
//   GFM 表格沿用 markdown-it
//
// 实现要点：
// - 先把围栏代码、行内代码“遮蔽”（shielded）成空格，所有纯文本扫描都基于 shielded 文本，
//   因此代码里的 $ / [@..] / [S01, p.3] / ![]() 不会被误判。
// - 图 / 交叉引用 / 来源标记在渲染前替换成私用区占位符 \uE000<index>\uE001，markdown-it
//   渲染后再换成 HTML；占位符不是 markdown 特殊字符，不会被转义或改写。
// - 标题 id 由 core 规则按 token.map[0]（0 基行号）回填；callout 内部的标题跳过。
import path from 'node:path'
import { createRequire } from 'node:module'
import { VENDOR_DIR } from '../paths.mjs'
import { renderMath, escapeHtml, escapeAttr } from './math.mjs'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const CALLOUT_KINDS = 'NOTE|WARN|CLARIFY|DERIVE|EXAMPLE|CHECK'
const CALLOUT_RE = new RegExp(`^ {0,3}>\\s*\\[!(${CALLOUT_KINDS})\\](?:[ \\t]+(.*))?\\s*$`, 'i')
const MARKER_RE = /\[([A-Za-z]\d+)\s*,\s*([^\]\n]+)\]/g
// 图注（alt）允许一层方括号，例如「区间 [-2, 2]」；否则图注里的 ] 会提前终止匹配。
const FIGURE_RE = /!\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)(?:[ \t]*\{([^}\n]*)\})?/g
const XREF_RE = /\[@([A-Za-z0-9_][A-Za-z0-9_:.\-]*)\]/g
const ATX_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/

/* ------------------------------------------------------------------ *
 * 文本工具
 * ------------------------------------------------------------------ */

function normalizeText(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

/** 每一行起始偏移（0 基索引 → 字符偏移）。 */
function lineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

/** 二分查找字符偏移所在的 1 基行号。 */
function lineAt(starts, offset) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/**
 * 遮蔽围栏代码与行内代码（内容替换为空格，保留长度与换行）。
 * @returns {{shielded: string, codeFences: Array<{lang: string, startLine: number, endLine: number}>}}
 */
function shieldText(text) {
  const starts = lineStarts(text)
  const lineEnd = (index) => (index + 1 < starts.length ? starts[index + 1] - 1 : text.length)
  const lineText = (index) => text.slice(starts[index], lineEnd(index))
  const chars = text.split('')
  const blank = (from, to) => {
    for (let i = from; i < to && i < chars.length; i += 1) {
      if (chars[i] !== '\n') chars[i] = ' '
    }
  }

  const codeFences = []
  let line = 0
  while (line < starts.length) {
    const open = FENCE_OPEN_RE.exec(lineText(line))
    if (!open) {
      line += 1
      continue
    }
    const fence = open[1]
    const marker = fence[0]
    const info = open[2].trim()
    const lang = info ? info.split(/\s+/)[0].replace(/[^\w.+#-]/g, '') : ''
    let closeLine = -1
    for (let j = line + 1; j < starts.length; j += 1) {
      const close = FENCE_CLOSE_RE.exec(lineText(j))
      if (close && close[1][0] === marker && close[1].length >= fence.length) {
        closeLine = j
        break
      }
    }
    const endLine = closeLine >= 0 ? closeLine : starts.length - 1
    blank(starts[line], lineEnd(endLine) + 1)
    codeFences.push({ lang, startLine: line + 1, endLine: endLine + 1 })
    line = endLine + 1
  }

  // 行内代码：按行扫描反引号串（围栏行已被遮蔽，不会命中）。
  for (let current = 0; current < starts.length; current += 1) {
    let pos = starts[current]
    const end = lineEnd(current)
    while (pos < end) {
      if (chars[pos] === '\\') {
        pos += 2
        continue
      }
      if (chars[pos] !== '`') {
        pos += 1
        continue
      }
      let run = 0
      while (pos + run < end && chars[pos + run] === '`') run += 1
      let search = pos + run
      let closeAt = -1
      while (search < end) {
        if (chars[search] === '`') {
          let closeRun = 0
          while (search + closeRun < end && chars[search + closeRun] === '`') closeRun += 1
          if (closeRun === run) {
            closeAt = search
            break
          }
          search += closeRun
          continue
        }
        search += 1
      }
      if (closeAt >= 0) {
        blank(pos, closeAt + run)
        pos = closeAt + run
      } else {
        pos += run
      }
    }
  }

  return { shielded: chars.join(''), codeFences }
}

/** 解析 `{#id .class width=70% key="a b"}` 形式的属性串。 */
function parseAttrs(raw) {
  const attrs = {}
  const re = /([#.]?[A-Za-z_][\w:.-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s]+))?/g
  let match
  const text = String(raw ?? '')
  while ((match = re.exec(text)) !== null) {
    const token = match[1]
    let value = match[2]
    if (value == null) {
      if (token.startsWith('#')) attrs.id = token.slice(1)
      else if (token.startsWith('.')) (attrs.class ??= []).push(token.slice(1))
      else attrs[token] = true
      continue
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (token.startsWith('#')) attrs.id = value
    else attrs[token] = value
  }
  return attrs
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

function countWords(text) {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length
  const latin = (text.match(/[A-Za-z0-9_]+(?:['’][A-Za-z]+)*/g) ?? []).length
  return cjk + latin
}

function findClosing(text, from, delimiter) {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1
      continue
    }
    if (text.startsWith(delimiter, i)) return i
  }
  return -1
}

/* ------------------------------------------------------------------ *
 * 纯文本扫描（全部基于 shielded 文本；行号回到原文）
 * ------------------------------------------------------------------ */

function scanHeadings(shielded) {
  const lines = shielded.split('\n')
  const headings = []
  lines.forEach((line, index) => {
    const match = ATX_RE.exec(line)
    if (!match) return
    const level = match[1].length
    let title = match[2].trim()
    let id = null
    const attr = /^(.*?)[ \t]*\{#([^{}\s]+)\}$/.exec(title)
    if (attr && attr[1].trim()) {
      title = attr[1].trim()
      id = attr[2]
    }
    headings.push({ id, level, title, line: index + 1, explicit: Boolean(id) })
  })
  // 自动 id 必须避开显式 id，否则 `# 标题` 会与后面的 `{#sec-1}` 撞车。
  const used = new Set(headings.map((heading) => heading.id).filter(Boolean))
  let auto = 0
  for (const heading of headings) {
    if (heading.id) continue
    do {
      auto += 1
    } while (used.has(`sec-${auto}`))
    heading.id = `sec-${auto}`
    used.add(heading.id)
  }
  return headings
}

function scanSourceMarkers(shielded, starts) {
  const markers = []
  MARKER_RE.lastIndex = 0
  let match
  while ((match = MARKER_RE.exec(shielded)) !== null) {
    const sourceId = match[1].toUpperCase()
    const loc = match[2].trim()
    const marker = {
      raw: match[0],
      sourceId,
      kind: 'page',
      page: undefined,
      section: undefined,
      time: undefined,
      loc,
      line: lineAt(starts, match.index),
      start: match.index,
      end: match.index + match[0].length,
    }
    const page = /^(?:pp?\.?|pages?)\s*(\d+(?:\s*[-–~]\s*\d+)?)/i.exec(loc)
    const section = /^(?:§+\s*|sec(?:tion)?\.?\s*)([\w.\-]+)/i.exec(loc)
    const time = /^(\d{1,2}:\d{2}(?::\d{2})?)$/.exec(loc)
    if (page) {
      marker.kind = 'page'
      marker.page = page[1]
    } else if (section) {
      marker.kind = 'section'
      marker.section = section[1]
    } else if (time) {
      marker.kind = 'time'
      marker.time = time[1]
    } else {
      marker.kind = 'page'
      marker.page = loc
    }
    markers.push(marker)
  }
  return markers
}

function scanCallouts(shielded) {
  const lines = shielded.split('\n')
  const callouts = []
  lines.forEach((line, index) => {
    const match = CALLOUT_RE.exec(line)
    if (!match) return
    const kind = match[1].toLowerCase()
    const title = (match[2] ?? '').trim()
    let last = index
    let next = index + 1
    while (next < lines.length) {
      const probe = lines[next]
      if (/^ {0,3}>/.test(probe)) {
        last = next
        next += 1
        continue
      }
      if (/^\s*$/.test(probe)) {
        // 空行只有后面仍跟着 “>” 行时才属于 callout；遇到下一个标注块则结束。
        let look = next + 1
        while (look < lines.length && /^\s*$/.test(lines[look])) look += 1
        if (look < lines.length && /^ {0,3}>/.test(lines[look])) {
          if (CALLOUT_RE.test(lines[look])) break
          last = next
          next += 1
          continue
        }
      }
      break
    }
    callouts.push({ kind, title, line: index + 1, endLine: last + 1, markers: [] })
  })
  return callouts
}

function scanFigures(shielded, starts) {
  const figures = []
  FIGURE_RE.lastIndex = 0
  let match
  while ((match = FIGURE_RE.exec(shielded)) !== null) {
    const attrs = parseAttrs(match[3] ?? '')
    const file = match[2].split(/[\\/]/).pop() ?? match[2]
    figures.push({
      assetId: file.replace(/\.[^.]+$/, ''),
      caption: match[1].trim(),
      path: match[2],
      line: lineAt(starts, match.index),
      width: typeof attrs.width === 'string' ? attrs.width : null,
      attrs,
      id: attrs.id ?? null,
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return figures
}

function scanXrefs(shielded, starts) {
  const refs = []
  XREF_RE.lastIndex = 0
  let match
  while ((match = XREF_RE.exec(shielded)) !== null) {
    refs.push({
      target: match[1],
      line: lineAt(starts, match.index),
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return refs
}

function scanMath(shielded, starts) {
  const math = []
  const equations = []
  let i = 0
  while (i < shielded.length) {
    const ch = shielded[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch !== '$') {
      i += 1
      continue
    }
    if (shielded[i + 1] === '$') {
      const close = findClosing(shielded, i + 2, '$$')
      if (close < 0) {
        i += 2
        continue
      }
      const tex = shielded.slice(i + 2, close)
      const line = lineAt(starts, i)
      let after = close + 2
      let id = null
      const idMatch = /^[ \t]*\{#([^{}\s]+)\}/.exec(shielded.slice(after, after + 160))
      if (idMatch) {
        id = idMatch[1]
        after += idMatch[0].length
      }
      math.push({ tex, display: true, line, start: i, end: after })
      equations.push({ id, tex, line })
      i = after
      continue
    }
    // 行内公式：不能跨空行，结尾 $ 前不能是空白
    let end = i + 1
    let closed = -1
    while (end < shielded.length) {
      const cur = shielded[end]
      if (cur === '\\') {
        end += 2
        continue
      }
      if (cur === '\n' && shielded[end + 1] === '\n') break
      if (cur === '$') {
        closed = end
        break
      }
      end += 1
    }
    if (closed < 0 || closed === i + 1) {
      i += 1
      continue
    }
    const tex = shielded.slice(i + 1, closed)
    if (!tex.trim() || /\s$/.test(tex) || tex.startsWith('$')) {
      i += 1
      continue
    }
    math.push({ tex, display: false, line: lineAt(starts, i), start: i, end: closed + 1 })
    i = closed + 1
  }
  math.sort((a, b) => a.start - b.start)
  return { math, equations }
}

/**
 * 纯文本扫描 Markdown（跳过围栏代码与行内代码），产出审计用结构。
 * @param {string} mdText
 */
export function analyzeMarkdown(mdText) {
  const text = normalizeText(mdText)
  const starts = lineStarts(text)
  const { shielded, codeFences } = shieldText(text)
  const headings = scanHeadings(shielded)
  const markers = scanSourceMarkers(shielded, starts)
  const callouts = scanCallouts(shielded)
  const figures = scanFigures(shielded, starts)
  const refs = scanXrefs(shielded, starts)
  const { math, equations } = scanMath(shielded, starts)

  for (const callout of callouts) {
    callout.markers = markers.filter((marker) => marker.line >= callout.line && marker.line <= callout.endLine)
  }

  return {
    sections: headings.slice(),
    headings,
    markers,
    callouts,
    figures,
    refs: refs.map(({ target, line }) => ({ target, line })),
    equations,
    math,
    codeFences,
    wordCount: countWords(shielded),
    chars: text.length,
  }
}

/* ------------------------------------------------------------------ *
 * markdown-it 实例与自定义规则
 * ------------------------------------------------------------------ */

let MarkdownItCtor = null
let markdownInstance = null

function getMarkdown() {
  if (markdownInstance) return markdownInstance

  if (!MarkdownItCtor) {
    // markdown-it 14.1.0 以 CJS 入口（dist/index.cjs.js）vendored，用 createRequire 同步加载，
    // 从而保持 renderMarkdown 的同步接口；ESM 入口 index.mjs 也可用 import() 换用。
    const require = createRequire(import.meta.url)
    MarkdownItCtor = require(path.join(VENDOR_DIR, 'markdown-it'))
  }

  const md = new MarkdownItCtor({
    html: false,
    linkify: false,
    breaks: false,
    typographer: false,
    highlight: highlightCode,
  })

  md.block.ruler.before('fence', 'lf_math_block', mathBlockRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  })
  md.block.ruler.before('blockquote', 'lf_callout', calloutBlockRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  })
  md.inline.ruler.before('text', 'lf_math_inline', mathInlineRule)
  md.core.ruler.at('inline', inlineCoreRule)
  md.core.ruler.push('lf_heading_ids', headingIdRule)

  md.renderer.rules.callout_open = (tokens, idx) => {
    const meta = tokens[idx].meta ?? {}
    const kind = meta.kind ?? 'note'
    const title = meta.title ? `<p class="callout-title">${escapeHtml(meta.title)}</p>\n` : ''
    return `<div class="callout callout-${escapeAttr(kind)}">${title}`
  }
  md.renderer.rules.callout_close = () => '</div>\n'
  md.renderer.rules.math_inline = (tokens, idx, options, env) => {
    const token = tokens[idx]
    const { html, error } = renderMath(token.content, { display: false })
    if (error) env.mathErrors?.push({ tex: token.content, line: token.meta?.line ?? 0, message: error })
    return html
  }
  md.renderer.rules.math_display_inline = (tokens, idx, options, env) => {
    const token = tokens[idx]
    const { html, error } = renderMath(token.content, { display: true })
    if (error) env.mathErrors?.push({ tex: token.content, line: token.meta?.line ?? 0, message: error })
    return `<span class="math-display math-display-inline">${html}</span>`
  }
  md.renderer.rules.math_block = (tokens, idx, options, env) => {
    const token = tokens[idx]
    const meta = token.meta ?? {}
    const { html, error } = renderMath(token.content.trim(), { display: true })
    if (error) env.mathErrors?.push({ tex: token.content, line: meta.line ?? 0, message: error })
    const id = meta.id ? ` id="${escapeAttr(meta.id)}"` : ''
    const number = meta.number ? `<span class="eqno">(${escapeHtml(meta.number)})</span>` : ''
    return `<div class="math-display"${id}>${html}${number}</div>\n`
  }
  md.renderer.rules.code_block = (tokens, idx) => {
    return `<pre class="code"><code>${escapeHtml(tokens[idx].content)}</code></pre>\n`
  }

  markdownInstance = md
  return md
}

function highlightCode(code, lang) {
  const language = String(lang ?? '').trim().split(/\s+/)[0].replace(/[^\w.+#-]/g, '')
  const cls = language ? ` class="language-${escapeAttr(language)}"` : ''
  return `<pre class="code"><code${cls}>${escapeHtml(code)}</code></pre>\n`
}

/** 内联 core 规则：给每个 inline token 记录其块级起始行，供公式错误定位。 */
function inlineCoreRule(state) {
  const tokens = state.tokens
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.type !== 'inline') continue
    state.env.__lfLine = (state.env.__lfLineOffset ?? 0) + (token.map ? token.map[0] : 0)
    state.md.inline.parse(token.content, state.md, state.env, token.children)
  }
}

/** 标题 id：按 0 基行号匹配分析结果；callout 内部标题跳过（由 callout 规则自行编号）。 */
function headingIdRule(state) {
  const byLine = state.env.__lfHeadingByLine
  let depth = 0
  for (const token of state.tokens) {
    if (token.type === 'callout_open') {
      depth += 1
      continue
    }
    if (token.type === 'callout_close') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth > 0 || token.type !== 'heading_open') continue
    const lineIndex = token.map ? token.map[0] : -1
    const section = byLine instanceof Map ? byLine.get(lineIndex) : undefined
    let id = section?.id
    if (!id) {
      state.env.__lfAutoHeading = (state.env.__lfAutoHeading ?? 0) + 1
      id = `sec-auto-${state.env.__lfAutoHeading}`
    }
    token.attrSet('id', id)
  }
}

/* ------------------------------------------------------------------ *
 * 块级 / 行内规则
 * ------------------------------------------------------------------ */

function calloutBlockRule(state, startLine, endLine, silent) {
  const start = state.bMarks[startLine] + state.tShift[startLine]
  if (state.src.charCodeAt(start) !== 0x3e /* > */) return false
  const lineEnd = state.eMarks[startLine]
  const firstLine = state.src.slice(start, lineEnd)
  const match = CALLOUT_RE.exec(firstLine)
  if (!match) return false
  if (silent) return true

  const kind = match[1].toLowerCase()
  const title = (match[2] ?? '').trim()
  const innerLines = []
  const innerIndex = []
  let cursor = startLine + 1
  let last = startLine
  while (cursor < endLine) {
    const lineStart = state.bMarks[cursor] + state.tShift[cursor]
    const currentEnd = state.eMarks[cursor]
    const raw = state.src.slice(lineStart, currentEnd)
    const trimmed = raw.trim()
    if (/^>/.test(trimmed)) {
      const indent = Math.min(3, Math.max(0, state.sCount[cursor] - state.blkIndent - 2))
      innerLines.push(' '.repeat(indent) + trimmed.replace(/^>\s?/, ''))
      innerIndex.push(cursor)
      last = cursor
      cursor += 1
      continue
    }
    if (!trimmed) {
      // 空行后紧跟另一个标注块时，当前标注块到此结束。
      let look = cursor + 1
      while (look < endLine) {
        const lookStart = state.bMarks[look] + state.tShift[look]
        const lookLine = state.src.slice(lookStart, state.eMarks[look])
        if (lookLine.trim()) {
          if (/^ {0,3}>/.test(lookLine) && CALLOUT_RE.test(lookLine)) {
            cursor = endLine
          }
          break
        }
        look += 1
      }
      if (cursor >= endLine) break
      innerLines.push('')
      innerIndex.push(cursor)
      cursor += 1
      continue
    }
    break
  }
  while (innerLines.length > 0 && innerLines[innerLines.length - 1] === '') {
    innerLines.pop()
    innerIndex.pop()
  }
  if (innerLines.length === 0) innerLines.push('')

  const open = state.push('callout_open', 'div', 1)
  open.block = true
  open.map = [startLine, last + 1]
  open.meta = { kind, title, line: startLine + 1 }

  const previousOffset = state.env.__lfLineOffset
  state.env.__lfLineOffset = (previousOffset ?? 0) + (innerIndex[0] ?? startLine + 1)
  state.md.block.parse(innerLines.join('\n'), state.md, state.env, state.tokens)
  state.env.__lfLineOffset = previousOffset

  const close = state.push('callout_close', 'div', -1)
  close.block = true
  state.line = last + 1
  return true
}

function mathBlockRule(state, startLine, endLine, silent) {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false
  const start = state.bMarks[startLine] + state.tShift[startLine]
  if (state.src.charCodeAt(start) !== 0x24 || state.src.charCodeAt(start + 1) !== 0x24) return false
  if (state.src.charCodeAt(start + 2) === 0x24) return false
  if (silent) return true

  const close = findClosing(state.src, start + 2, '$$')
  if (close < 0) return false
  const tex = state.src.slice(start + 2, close)

  let closeLine = startLine
  while (closeLine + 1 < endLine && state.bMarks[closeLine + 1] <= close) closeLine += 1

  const lineEnd = state.src.indexOf('\n', close)
  const tail = state.src.slice(close + 2, lineEnd < 0 ? state.src.length : lineEnd)
  const idMatch = /^[ \t]*\{#([^{}\s]+)\}/.exec(tail)
  const id = idMatch ? idMatch[1] : null

  const token = state.push('math_block', 'math', 0)
  token.block = true
  token.content = tex
  token.map = [startLine, closeLine + 1]
  token.meta = {
    id,
    number: id ? id.replace(/^eq-/, '') : null,
    line: (state.env.__lfLineOffset ?? 0) + startLine + 1,
  }
  state.line = closeLine + 1
  return true
}

function mathInlineRule(state, silent) {
  const start = state.pos
  const src = state.src
  if (src.charCodeAt(start) !== 0x24 /* $ */) return false

  const lineOf = (offset) => (state.env.__lfLine ?? 0) + src.slice(0, offset).split('\n').length

  if (src.charCodeAt(start + 1) === 0x24) {
    const close = findClosing(src, start + 2, '$$')
    if (close < 0) return false
    const region = src.slice(start + 2, close)
    if (!region.trim() || /\n\s*\n/.test(region)) return false
    if (silent) return true
    const token = state.push('math_display_inline', 'math', 0)
    token.content = region
    token.meta = { line: lineOf(start) }
    state.pos = close + 2
    return true
  }

  let idx = start + 1
  let closed = -1
  while (idx < src.length) {
    const cur = src.charCodeAt(idx)
    if (cur === 0x5c /* \ */) {
      idx += 2
      continue
    }
    if (cur === 0x0a && src.charCodeAt(idx + 1) === 0x0a) return false
    if (cur === 0x24) {
      closed = idx
      break
    }
    idx += 1
  }
  if (closed < 0 || closed === start + 1) return false
  const tex = src.slice(start + 1, closed)
  if (!tex.trim() || /\s$/.test(tex)) return false
  if (silent) return true
  const token = state.push('math_inline', 'math', 0)
  token.content = tex
  token.meta = { line: lineOf(start) }
  state.pos = closed + 1
  return true
}

/* ------------------------------------------------------------------ *
 * HTML 片段
 * ------------------------------------------------------------------ */

function cleanCaption(caption) {
  return String(caption ?? '')
    .replace(/^(?:图|Figure|Fig\.?)\s*\d+\s*[:：.、\-–—]?\s*/i, '')
    .trim()
}

function figureHtml(figure, anchor, number, label) {
  const width =
    typeof figure.width === 'string' && /^[0-9.]+(?:%|px|em|rem|cm|mm|pt)?$/.test(figure.width)
      ? figure.width
      : null
  const style = width ? ` style="width:${width}"` : ''
  const caption = cleanCaption(figure.caption)
  const captionText = caption ? `${label.figure} ${number}：${caption}` : `${label.figure} ${number}`
  return (
    `<figure class="lf-figure" id="${escapeAttr(anchor)}">` +
    `<img src="${escapeAttr(figure.path)}"${style}>` +
    `<figcaption>${escapeHtml(captionText)}</figcaption>` +
    '</figure>'
  )
}

function markerHtml(marker) {
  const loc = marker.loc ?? formatMarkerLoc(marker)
  return (
    `<sup class="src-ref" data-src="${escapeAttr(marker.sourceId)}" data-loc="${escapeAttr(loc)}">` +
    `[${escapeHtml(marker.sourceId)}·${escapeHtml(loc)}]</sup>`
  )
}

function formatMarkerLoc(marker) {
  if (marker.kind === 'section') return `§${marker.section}`
  if (marker.kind === 'time') return marker.time
  return `p.${marker.page}`
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

/**
 * 渲染方言 Markdown。
 * @param {string} mdText
 * @param {{language?: string}} [options]
 * @returns {{html: string, analysis: object, mathErrors: Array<{tex: string, line: number, message: string}>, warnings: string[]}}
 */
export function renderMarkdown(mdText, { language = 'zh' } = {}) {
  const text = normalizeText(mdText)
  const analysis = analyzeMarkdown(text)
  const starts = lineStarts(text)
  const { shielded } = shieldText(text)
  const isEnglish = String(language ?? 'zh').toLowerCase().startsWith('en')
  const label = isEnglish ? { figure: 'Figure', equation: 'Equation' } : { figure: '图', equation: '式' }
  const warnings = []
  const mathErrors = []

  // 图编号：按出现顺序自动分配 图 n/Figure n，并建立 id/assetId → 编号映射
  const figureAnchors = new Map()
  const figureByStart = new Map()
  const usedFigureIds = new Set()
  analysis.figures.forEach((figure, index) => {
    const number = index + 1
    const anchor = figure.id ?? figure.assetId ?? `fig-${number}`
    if (usedFigureIds.has(anchor)) warnings.push(`重复的图 id：${anchor}`)
    usedFigureIds.add(anchor)
    const info = { anchor, number }
    figureAnchors.set(anchor, info)
    if (figure.id && figure.assetId && !figureAnchors.has(figure.assetId)) {
      figureAnchors.set(figure.assetId, info)
    }
    figureByStart.set(figure.start, info)
  })

  const sectionMap = new Map()
  for (const section of analysis.sections) {
    if (sectionMap.has(section.id)) warnings.push(`重复的章节 id：${section.id}`)
    sectionMap.set(section.id, section)
  }

  const equationNumbers = new Map()
  for (const equation of analysis.equations) {
    if (!equation.id) continue
    if (equationNumbers.has(equation.id)) warnings.push(`重复的公式 id：${equation.id}`)
    equationNumbers.set(equation.id, equation.id.replace(/^eq-/, ''))
  }

  const xrefHtml = (target) => {
    const figure = figureAnchors.get(target)
    if (figure) {
      return `<a class="xref" href="#${escapeAttr(figure.anchor)}">${label.figure} ${figure.number}</a>`
    }
    const section = sectionMap.get(target)
    if (section) {
      const textLabel = stripInlineMarkup(section.title) || section.id
      return `<a class="xref" href="#${escapeAttr(target)}">${escapeHtml(textLabel)}</a>`
    }
    const equationNumber = equationNumbers.get(target)
    if (equationNumber != null) {
      return `<a class="xref" href="#${escapeAttr(target)}">${label.equation} (${escapeHtml(equationNumber)})</a>`
    }
    warnings.push(`未解析的交叉引用：[@${target}]`)
    return `<span class="xref broken">[@${escapeAttr(target)}]</span>`
  }

  // 先占位后替换：图 / 交叉引用 / 来源标记
  const ranges = []
  for (const figure of scanFigures(shielded, starts)) {
    const info = figureByStart.get(figure.start)
    if (!info) continue
    ranges.push({
      start: figure.start,
      end: figure.end,
      block: true,
      html: figureHtml(figure, info.anchor, info.number, label),
    })
  }
  for (const ref of scanXrefs(shielded, starts)) {
    ranges.push({ start: ref.start, end: ref.end, block: false, html: xrefHtml(ref.target) })
  }
  for (const marker of scanSourceMarkers(shielded, starts)) {
    ranges.push({ start: marker.start, end: marker.end, block: false, html: markerHtml(marker) })
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end)
  const accepted = []
  let cursor = -1
  for (const range of ranges) {
    if (range.start < cursor) continue // 嵌套区间（如图注内的来源标记）让位给外层图
    accepted.push(range)
    cursor = range.end
  }

  const placeholders = accepted.map((range, index) => ({
    placeholder: `\uE000${index}\uE001`,
    html: range.html,
    block: range.block,
  }))
  let working = text
  for (let i = accepted.length - 1; i >= 0; i -= 1) {
    working = working.slice(0, accepted[i].start) + placeholders[i].placeholder + working.slice(accepted[i].end)
  }

  // 消除标题行末尾的 {#...}（callout 内部的标题也一并消除，但编号已在分析阶段固定）
  working = working
    .split('\n')
    .map((line) => (/^ {0,3}#{1,6}[ \t]/.test(line) ? line.replace(/\s*\{#[^{}\s]+\}\s*$/, '') : line))
    .join('\n')

  const env = {
    mathErrors,
    __lfHeadingByLine: new Map(analysis.sections.map((section) => [section.line - 1, section])),
    __lfLineOffset: 0,
  }
  let html = getMarkdown().render(working, env)
  html = replacePlaceholders(html, placeholders)

  if (html.includes('\uE000')) {
    html = html.replace(/\uE000\d*\uE001/g, '')
    warnings.push('存在未能还原的占位符，已移除。')
  }

  return {
    html,
    analysis,
    mathErrors,
    warnings: [...new Set(warnings)],
  }
}

function replacePlaceholders(html, placeholders) {
  let out = html
  for (const item of placeholders) {
    const paragraph = new RegExp(`<p>\\s*${item.placeholder}\\s*</p>\\n?`)
    if (paragraph.test(out)) {
      out = out.replace(paragraph, item.html)
    } else {
      out = out.split(item.placeholder).join(item.html)
    }
  }
  return out
}
