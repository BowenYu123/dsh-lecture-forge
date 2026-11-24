// LectureForge — URL 摄取（抓取 HTML、猜测编码、再交给 HTML 解析器）。
import { LectureError } from '../projects.mjs'
import { fetchBufferLimited, parseHtml } from './html.mjs'

const URL_LIMIT = 15 * 1024 * 1024

/**
 * @param {{url:string, config?:object, warnings?:string[], signal?:AbortSignal|null}} input
 */
export async function parseUrl({ url, config = {}, warnings = [], signal = null } = {}) {
  const target = String(url ?? '').trim()
  let parsedUrl
  try {
    parsedUrl = new URL(target)
  } catch {
    throw new LectureError('URL_INVALID', `无效的网页地址：${target}`, '请提供 http:// 或 https:// 开头的完整 URL。')
  }
  if (!/^https?:$/.test(parsedUrl.protocol)) {
    throw new LectureError('URL_INVALID', `仅支持 http/https 网页：${target}`)
  }

  let response
  try {
    response = await fetchBufferLimited(target, {
      limit: URL_LIMIT,
      timeoutMs: 30000,
      signal,
      accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
    })
  } catch (error) {
    const message = String(error?.message ?? error)
    if (signal?.aborted || error?.name === 'AbortError') {
      throw new LectureError('ABORTED', '网页摄取已取消。')
    }
    const http = /^HTTP\s+(\d+)/.exec(message)
    if (http) {
      throw new LectureError(
        'URL_HTTP_ERROR',
        `抓取网页失败：HTTP ${http[1]}（${target}）`,
        '请确认链接可公开访问，或先下载网页为 .html 文件。',
      )
    }
    throw new LectureError(
      'URL_FETCH_FAILED',
      `无法抓取网页 ${target}：${message}`,
      '请检查网络连接、代理设置，或先下载网页为 .html 文件。',
    )
  }

  const html = decodeHtml(response.buffer, response.contentType)
  const parsed = await parseHtml({
    html,
    file: null,
    baseDir: null,
    baseUrl: response.finalUrl || target,
    warnings,
    signal,
  })
  parsed.kind = 'url'
  parsed.metadata = {
    ...parsed.metadata,
    url: target,
    ...(response.finalUrl && response.finalUrl !== target ? { finalUrl: response.finalUrl } : {}),
  }
  const textChars = parsed.units
    .filter((unit) => ['text', 'heading', 'table', 'code', 'formula'].includes(unit.kind))
    .reduce((sum, unit) => sum + String(unit.text ?? '').length, 0)
  if (textChars < 200) {
    warnings.push(
      `网页正文不足 200 字符（${textChars} 字符），可能由 JS 渲染，请下载为 .html 或用 PDF 版本。`,
    )
  }
  return parsed
}

function decodeHtml(buffer, contentType) {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(String(contentType ?? ''))?.[1]
  const head = buffer.subarray(0, 8192).toString('latin1')
  const fromMeta =
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ??
    /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i.exec(head)?.[1]
  const candidates = [fromHeader, fromMeta, 'utf-8'].filter(
    (value, index, list) => value && list.indexOf(value) === index,
  )
  for (const charset of candidates) {
    try {
      const decoded = new TextDecoder(charset).decode(buffer)
      return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded
    } catch {
      /* 尝试下一个编码 */
    }
  }
  return new TextDecoder('utf-8').decode(buffer).replace(/^\uFEFF/, '')
}
