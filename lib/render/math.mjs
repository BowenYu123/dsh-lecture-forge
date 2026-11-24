// LectureForge — 数学公式渲染（KaTeX 0.19.1，随插件内置）。
//
// 设计要点：
// - KaTeX 以 UMD 形式 vendored 在 assets/vendor/katex/katex.min.js，用 createRequire 同步加载，
//   这样 renderMarkdown / renderHtmlDocument 可以保持同步接口（工具层按此对接）。
// - katexCss({ embedFonts: true }) 生成完全自包含的样式：把 katex.min.css 内联，并把
//   fonts/KaTeX_*.woff2 替换成 base64 data:font/woff2，导出的单个 HTML 文件即可离线打开。
// - 公式解析失败不抛异常：返回可读错误串 + 降级 HTML，调用方（渲染器）收集为 mathErrors。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { VENDOR_DIR } from '../paths.mjs'
import { LectureError } from '../projects.mjs'

export const KATEX_DIR = path.join(VENDOR_DIR, 'katex')
export const KATEX_JS = path.join(KATEX_DIR, 'katex.min.js')
export const KATEX_CSS = path.join(KATEX_DIR, 'katex.min.css')
export const KATEX_FONTS_DIR = path.join(KATEX_DIR, 'fonts')

/** KaTeX 负载的缓存：加载一次后复用；加载失败也缓存错误，避免反复读盘。 */
let katexInstance = null

/**
 * 同步加载内置 KaTeX。
 * @returns {{renderToString: Function, version?: string}}
 * @throws {LectureError} code = 'MATH_ENGINE_MISSING'
 */
export function loadKatex() {
  if (katexInstance) return katexInstance
  try {
    if (!fs.existsSync(KATEX_JS)) {
      throw new Error(`缺少 ${KATEX_JS}`)
    }
    const require = createRequire(import.meta.url)
    const loaded = require(KATEX_JS)
    const katex = loaded && typeof loaded.renderToString === 'function' ? loaded : loaded?.default
    if (!katex || typeof katex.renderToString !== 'function') {
      throw new Error('katex.min.js 未导出 renderToString')
    }
    katexInstance = katex
    return katex
  } catch (error) {
    throw mathEngineMissing(error)
  }
}

function mathEngineMissing(error) {
  return new LectureError(
    'MATH_ENGINE_MISSING',
    `数学引擎 KaTeX 不可用：${error?.message ?? error}`,
    '插件 assets/vendor/katex 应包含 katex.min.js、katex.min.css 与 fonts/*.woff2；请重新安装插件或重新打包 vendor 资源。'
  )
}

/**
 * 渲染单个公式。
 * @param {string} tex LaTeX 源码
 * @param {{display?: boolean}} [options]
 * @returns {{html: string, error: string|null}}
 */
export function renderMath(tex, { display = false } = {}) {
  const source = String(tex ?? '')
  const katex = loadKatex() // 引擎缺失属于安装问题，直接抛 LectureError
  try {
    const html = katex.renderToString(source, {
      displayMode: Boolean(display),
      throwOnError: true,
      strict: 'ignore',
      trust: false,
      output: 'htmlAndMathml',
      errorColor: '#b42318',
    })
    return { html, error: null }
  } catch (error) {
    const message = normalizeMathError(error, source)
    return { html: degradedMathHtml(source, message, display), error: message }
  }
}

/** 从 KaTeX 异常中提取一行可读信息（去掉栈与多余空白）。 */
function normalizeMathError(error, source) {
  const raw = error?.message ? String(error.message) : String(error ?? '公式渲染失败')
  const firstLine = raw.split('\n').find((line) => line.trim()) ?? raw
  const message = firstLine.replace(/^KaTeX parse error:\s*/i, '').trim()
  if (message) return message
  return `无法解析公式：${source.slice(0, 80)}`
}

function degradedMathHtml(source, message, display) {
  const tag = display ? 'div' : 'span'
  return (
    `<${tag} class="math-error" title="${escapeAttr(message)}" data-tex="${escapeAttr(source)}">` +
    `${escapeHtml(source)}</${tag}>`
  )
}

/** CSS 字体声明中出现的字重/样式组合 → woff2 文件名。 */
const FONT_FILES = {
  'KaTeX_AMS': 'KaTeX_AMS-Regular.woff2',
  'KaTeX_Caligraphic': {
    normal: { 400: 'KaTeX_Caligraphic-Regular.woff2', 700: 'KaTeX_Caligraphic-Bold.woff2' },
  },
  'KaTeX_Fraktur': {
    normal: { 400: 'KaTeX_Fraktur-Regular.woff2', 700: 'KaTeX_Fraktur-Bold.woff2' },
  },
  'KaTeX_Main': {
    normal: {
      400: 'KaTeX_Main-Regular.woff2',
      700: 'KaTeX_Main-Bold.woff2',
    },
    italic: {
      400: 'KaTeX_Main-Italic.woff2',
      700: 'KaTeX_Main-BoldItalic.woff2',
    },
  },
  'KaTeX_Math': {
    normal: { 400: 'KaTeX_Math-Bold.woff2' },
    italic: {
      400: 'KaTeX_Math-Italic.woff2',
      700: 'KaTeX_Math-BoldItalic.woff2',
    },
  },
  'KaTeX_SansSerif': {
    normal: {
      400: 'KaTeX_SansSerif-Regular.woff2',
      700: 'KaTeX_SansSerif-Bold.woff2',
    },
    italic: { 400: 'KaTeX_SansSerif-Italic.woff2' },
  },
  'KaTeX_Script': { normal: { 400: 'KaTeX_Script-Regular.woff2' } },
  'KaTeX_Size1': { normal: { 400: 'KaTeX_Size1-Regular.woff2' } },
  'KaTeX_Size2': { normal: { 400: 'KaTeX_Size2-Regular.woff2' } },
  'KaTeX_Size3': { normal: { 400: 'KaTeX_Size3-Regular.woff2' } },
  'KaTeX_Size4': { normal: { 400: 'KaTeX_Size4-Regular.woff2' } },
  'KaTeX_Typewriter': { normal: { 400: 'KaTeX_Typewriter-Regular.woff2' } },
}

function resolveFontFile(family, style, weight) {
  const entry = FONT_FILES[family]
  if (!entry) return null
  if (typeof entry === 'string') return entry
  const styleEntry = entry[style] ?? entry.normal
  if (!styleEntry) return null
  return styleEntry[weight] ?? styleEntry[400] ?? null
}

const fontDataCache = new Map()

function fontDataUrl(fileName) {
  if (fontDataCache.has(fileName)) return fontDataCache.get(fileName)
  const file = path.join(KATEX_FONTS_DIR, fileName)
  let url = null
  if (fs.existsSync(file)) {
    const base64 = fs.readFileSync(file).toString('base64')
    url = `data:font/woff2;base64,${base64}`
  }
  fontDataCache.set(fileName, url)
  return url
}

/**
 * 生成自包含的 KaTeX 样式。
 * @param {{embedFonts?: boolean}} [options]
 * @returns {string}
 * @throws {LectureError} code = 'MATH_ENGINE_MISSING'
 */
export function katexCss({ embedFonts = true } = {}) {
  let css
  try {
    css = fs.readFileSync(KATEX_CSS, 'utf8')
  } catch (error) {
    throw mathEngineMissing(error)
  }
  if (!embedFonts) return css
  // KaTeX 0.19 的 min.css 用双引号（format("woff2")），旧版本用单引号；两种都接受。
  return css.replace(
    /src:\s*url\(([^)]*?)\)\s*format\(["']woff2["']\)(?:\s*,\s*url\([^)]*?\)\s*format\(["']woff["']\))?(?:\s*,\s*url\([^)]*?\)\s*format\(["']truetype["']\))?/g,
    (match, url) => {
      const fileName = url.split('/').pop()?.split('?')[0] ?? ''
      const dataUrl = fontDataUrl(fileName)
      return dataUrl ? `src: url(${dataUrl}) format('woff2')` : match
    }
  )
}

/** 供 html.mjs 复用的转义工具（避免在两个模块各写一份而出现不一致）。 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function escapeAttr(value) {
  return escapeHtml(value).replace(/\r?\n/g, ' ')
}
