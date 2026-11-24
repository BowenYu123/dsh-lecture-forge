// lecture_figure — 图片资产：抽取页内区域、代码绘图、手写 SVG、检索下载。
import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { ensureDir, exists, PACKAGE_ROOT, PY_DIR } from '../paths.mjs'
import { pythonEnv } from '../config.mjs'
import { LectureError, loadFigures, loadProject, loadSources } from '../projects.mjs'
import { detectImageType, figuresIndex, imageSize, registerAsset, sanitizeSvg } from '../assets.mjs'
import { renderPdfPages } from '../render/qa.mjs'
import { run } from '../runner.mjs'
import { ok, fail, optionalInt, optionalString, projectDir, textOutput, toolSchema, wrap } from './common.mjs'

const PLOT_TYPES = ['line', 'scatter', 'parametric', 'vector_field', 'heatmap', 'contour']

function padFileMarkdown(record, width) {
  const w = Number.isInteger(width) ? width : 80
  return `![${record.caption ?? record.assetId}](${record.file}){#${record.assetId} width=${w}%}`
}

function requireNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LectureError('INVALID_ARGUMENT', `rect.${name} 必须是数字`)
  }
  return value
}

function normalizeRect(rect) {
  if (!rect || typeof rect !== 'object') throw new LectureError('MISSING_ARGUMENT', 'extract 需要 rect={x,y,width,height}（0..1 比例）')
  const x = requireNumber(rect.x, 'x')
  const y = requireNumber(rect.y, 'y')
  const width = requireNumber(rect.width, 'width')
  const height = requireNumber(rect.height, 'height')
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.001 || y + height > 1.001) {
    throw new LectureError('INVALID_ARGUMENT', 'rect 必须在页面内：x,y≥0，width,height>0，x+width≤1，y+height≤1')
  }
  return { x, y, width, height }
}

async function cropPng(src, dst, rect, python, signal) {
  const script = path.join(PACKAGE_ROOT, 'py', 'crop_image.py')
  const result = await run(
    python,
    [script, src, dst, String(rect.x), String(rect.y), String(rect.width), String(rect.height)],
    { timeoutMs: 60000, signal, env: pythonEnv() },
  )
  if (result.code !== 0) {
    throw new LectureError(
      'CROP_FAILED',
      `裁图失败：${result.stderr?.trim() || result.stdout?.trim() || `exit ${result.code}`}`,
      '需要 Python Pillow；也可改用整页截图后手工裁，或让 Agent 直接写 SVG 示意图',
    )
  }
  return dst
}

async function fetchImageBytes(url, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('fetch timeout')), 30000)
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  try {
    const response = await fetch(url, { signal: combined, redirect: 'follow' })
    if (!response.ok) throw new LectureError('FETCH_FAILED', `下载失败：HTTP ${response.status}`, url)
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > 20 * 1024 * 1024) throw new LectureError('FILE_TOO_LARGE', '远程图片超过 20MB')
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > 20 * 1024 * 1024) throw new LectureError('FILE_TOO_LARGE', '远程图片超过 20MB')
    return buffer
  } finally {
    clearTimeout(timer)
  }
}

export function makeFigureTool(config, getRuntime) {
  return {
    name: 'lecture_figure',
    description:
      '讲义配图：list 看已登记图；extract 从 PDF 某页按 rect 裁出原图；plot 用 numpy 精确绘图（line/scatter/parametric/vector_field/heatmap/contour）；svg 登记 Agent 手写示意图；url 下载并登记外部图片（需 license/author）。' +
      '返回 assetId 与可直接粘贴的 Markdown 图行；所有图必须登记出处，审计会检查。',
    parameters: toolSchema(
      {
        project: { type: 'string', description: '项目目录（相对会话工作区，缺省=工作区根）' },
        action: { type: 'string', enum: ['list', 'extract', 'plot', 'svg', 'url'], description: '操作类型' },
        sourceId: { type: 'string', description: 'extract/list：来源 id' },
        page: { type: 'integer', description: 'extract：页码（1-based）' },
        rect: {
          type: 'object',
          description: 'extract：页面内区域（0..1 比例）',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false,
        },
        spec: {
          type: 'object',
          description: 'plot：绘图规格，如 {type:"line", x:[...], y:[...]}；type 见枚举',
          properties: {
            type: { type: 'string', enum: PLOT_TYPES },
          },
          required: ['type'],
          additionalProperties: true,
        },
        svg: { type: 'string', description: 'svg：完整 SVG 文本（会被清洗 script/事件）' },
        url: { type: 'string', description: 'url：图片直链（https）' },
        license: { type: 'string', description: 'url/extract：许可，如 CC-BY-4.0 / public-domain / 版权方授权' },
        author: { type: 'string', description: 'url/extract：作者/来源方' },
        caption: { type: 'string', description: '图注' },
        width: { type: 'integer', description: '返回 Markdown 中的宽度百分比（20-100，缺省 80）' },
      },
      ['action'],
    ),
    output: textOutput(),
    execute: wrap(async (args, exec) => {
      const root = projectDir(exec, args)
      const project = loadProject(root)
      if (!project) throw new LectureError('NO_PROJECT', '项目未初始化', '先调用 lecture_init')
      const action = String(args.action ?? '')
      const runtime = await getRuntime()
      const widthArg = optionalInt(args, 'width', { min: 20, max: 100, fallback: 80 })

      if (action === 'list') {
        const figures = loadFigures(root).assets
        const only = optionalString(args, 'sourceId')
        const filtered = only ? figures.filter((f) => f.source?.sourceId === only) : figures
        if (!filtered.length) return ok('还没有登记任何图片。', { figures: [] })
        const lines = [`已登记 ${filtered.length} 张图片：`]
        for (const figure of filtered) {
          const origin = figure.source?.sourceId
            ? `${figure.source.sourceId} p.${figure.source.page ?? '?'}`
            : figure.source?.url
              ? `${figure.source.url}（${figure.source.license ?? '许可未登记'}）`
              : figure.kind
          lines.push(`- ${figure.assetId} [${figure.kind}] ${figure.width ?? '?'}×${figure.height ?? '?'} ${origin}｜${figure.caption ?? ''}`)
          lines.push(`  ${padFileMarkdown(figure, widthArg)}`)
        }
        return ok(lines.join('\n'), { figures: figuresIndex(root) })
      }

      if (action === 'extract') {
        const sourceId = optionalString(args, 'sourceId')
        if (!sourceId) return fail('MISSING_ARGUMENT', 'extract 需要 sourceId')
        const sources = loadSources(root)
        const source = sources.find((s) => s.sourceId === sourceId)
        if (!source) return fail('UNKNOWN_SOURCE', `找不到来源 ${sourceId}`)
        if (args.rect === undefined) {
          const page = optionalInt(args, 'page', { min: 1, max: config.maxPages })
          const figures = loadFigures(root).assets.filter((f) => f.source?.sourceId === sourceId && (!page || f.source?.page === page))
          return ok(
            figures.length
              ? `来源 ${sourceId} 已登记 ${figures.length} 张图（可为 extract 提供 rect 裁新图）：\n${figures
                  .map((f) => `- ${f.assetId} p.${f.source?.page ?? '?'} ${padFileMarkdown(f, widthArg)}`)
                  .join('\n')}`
              : `来源 ${sourceId} 没有已登记图。请提供 page + rect={x,y,width,height}（0..1）从页图裁切。`,
            { figures },
          )
        }
        const page = optionalInt(args, 'page', { min: 1, max: config.maxPages })
        if (!page) return fail('MISSING_ARGUMENT', 'extract 需要 page')
        const rect = normalizeRect(args.rect)
        const pdfPath = source.origin?.storedPathAbs ?? source.origin?.storedPath
        if (!pdfPath || !exists(pdfPath)) return fail('NO_RAW_FILE', '缺少原始 PDF（URL 来源或已清理）', '重新摄取本地 PDF，或用 svg 手绘示意图')
        if (!runtime.kit?.ok) return fail('KIT_UNAVAILABLE', 'LibreOffice Kit 不可用，无法栅格化页面', '配置 libreOfficeKitCli 或在 PDF 内直接用已有图片')
        const python = runtime.python?.path
        if (!python) return fail('PYTHON_MISSING', '找不到 Python，无法裁图', '配置 pythonPath')
        const tmpDir = path.join(root, '.lecture', 'tmp')
        ensureDir(tmpDir)
        const stamp = Date.now()
        const rendered = await renderPdfPages({
          pdfPath,
          outDir: tmpDir,
          pages: [page],
          dpi: 200,
          kit: runtime.kit,
          signal: exec?.signal,
          timeoutMs: config.buildTimeoutMs,
        })
        if (!rendered.ok || !rendered.pages?.length) {
          return fail('RENDER_FAILED', `页面栅格化失败：${rendered.message ?? '未知原因'}`)
        }
        const firstFile = rendered.pages.find((p) => p.page === page)?.file ?? rendered.pages[0].file
        const srcPng = firstFile
        const cropped = path.join(tmpDir, `crop-${stamp}.png`)
        await cropPng(srcPng, cropped, rect, python, exec?.signal)
        const data = await readFile(cropped)
        const record = await registerAsset(root, {
          data,
          kind: 'extracted',
          caption: optionalString(args, 'caption') ?? `${source.label} 第 ${page} 页区域`,
          source: {
            sourceId,
            page,
            bbox: rect,
            license: optionalString(args, 'license') ?? source.metadata?.license ?? null,
            author: optionalString(args, 'author') ?? null,
          },
        })
        return ok(
          `已裁出 ${record.assetId}（${record.width}×${record.height}）并登记。\n在正文引用：\n\`${padFileMarkdown(record, widthArg)}\`\n记得在附近保留来源标记 [${sourceId}, p.${page}]。`,
          { assetId: record.assetId, file: record.file, markdown: padFileMarkdown(record, widthArg), width: record.width, height: record.height },
        )
      }

      if (action === 'plot') {
        if (!args.spec || typeof args.spec !== 'object') return fail('MISSING_ARGUMENT', 'plot 需要 spec 对象', '示例：{type:"line", x:[0,1,2], y:[0,1,4], title:"…"}')
        const type = String(args.spec.type ?? '')
        if (!PLOT_TYPES.includes(type)) {
          return fail('INVALID_SPEC', `不支持的图类型：${type}`, `可用：${PLOT_TYPES.join(' / ')}`)
        }
        const python = runtime.python?.path
        if (!python) return fail('PYTHON_MISSING', '找不到 Python，无法绘图', '配置 pythonPath 或安装 numpy')
        const tmpDir = path.join(root, '.lecture', 'tmp')
        ensureDir(tmpDir)
        const stamp = Date.now()
        const specPath = path.join(tmpDir, `plot-spec-${stamp}.json`)
        const svgPath = path.join(tmpDir, `plot-${stamp}.svg`)
        await writeFile(specPath, JSON.stringify(args.spec), 'utf8')
        const scriptPath = path.join(PY_DIR, 'run_plot.py')
        const result = await run(python, [scriptPath, specPath, svgPath], {
          timeoutMs: 120000,
          signal: exec?.signal,
          env: pythonEnv(),
          cwd: root,
        })
        if (result.code !== 0 || !exists(svgPath)) {
          return fail(
            'PLOT_FAILED',
            `绘图失败：${(result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 1500)}`,
            '检查 spec 的字段（x/y/labels）；需要 numpy 的 Python 环境',
          )
        }
        const svg = await readFile(svgPath, 'utf8')
        const record = await registerAsset(root, {
          data: Buffer.from(svg, 'utf8'),
          type: 'svg',
          kind: 'plot',
          caption: optionalString(args, 'caption') ?? `由代码绘制的 ${type} 图`,
          source: { spec: args.spec, python: true },
        })
        return ok(
          `已生成 ${record.assetId}（代码绘图，${type}）。\n引用：\n\`${padFileMarkdown(record, widthArg)}\`\n绘图 spec 已记录，可复现；建议在正文说明数据点或公式含义。`,
          { assetId: record.assetId, file: record.file, markdown: padFileMarkdown(record, widthArg), width: record.width, height: record.height },
        )
      }

      if (action === 'svg') {
        const svg = optionalString(args, 'svg', { max: 300000 })
        if (!svg) return fail('MISSING_ARGUMENT', 'svg 需要完整 SVG 文本')
        if (!/<svg[\s>]/i.test(svg)) return fail('INVALID_SVG', '文本里没有 <svg> 根元素')
        const sanitized = sanitizeSvg(svg)
        const record = await registerAsset(root, {
          data: Buffer.from(sanitized, 'utf8'),
          type: 'svg',
          kind: 'svg',
          caption: optionalString(args, 'caption') ?? '示意图',
          source: { agentAuthored: true },
        })
        return ok(
          `已登记手绘示意图 ${record.assetId}（${record.width}×${record.height}，已清洗脚本与事件属性）。\n引用：\n\`${padFileMarkdown(record, widthArg)}\`\n注意：SVG 只作概念示意，精确函数图请用 plot。`,
          { assetId: record.assetId, file: record.file, markdown: padFileMarkdown(record, widthArg), width: record.width, height: record.height },
        )
      }

      if (action === 'url') {
        const url = optionalString(args, 'url', { max: 4096 })
        if (!url) return fail('MISSING_ARGUMENT', 'url 需要图片直链')
        const license = optionalString(args, 'license', { max: 200 })
        const author = optionalString(args, 'author', { max: 200 })
        if (config.strictLicensing && (!license || !author)) {
          return fail('LICENSING_REQUIRED', 'strictLicensing 开启时，外部图片必须提供 license 与 author', '补齐 license（如 CC-BY-4.0）与 author；或改用 plot/svg 自绘')
        }
        const buffer = await fetchImageBytes(url, exec?.signal)
        const type = detectImageType(buffer)
        if (!type) return fail('NOT_AN_IMAGE', '下载内容不是可识别的图片（PNG/JPEG/WebP/GIF/SVG）', '确认是图片直链而不是网页')
        let size = null
        try {
          size = imageSize(buffer, type)
        } catch {
          size = null
        }
        const record = await registerAsset(root, {
          data: buffer,
          type,
          kind: 'web',
          caption: optionalString(args, 'caption') ?? `外部图片（${author ?? '来源未注明'}）`,
          source: { url, license: license ?? null, author: author ?? null, fetchedAt: new Date().toISOString() },
        })
        return ok(
          `已下载并登记 ${record.assetId}（${type}，${size ? `${size.width}×${size.height}` : '尺寸未知'}）。\n引用：\n\`${padFileMarkdown(record, widthArg)}\`\n正文需保留来源与许可说明。`,
          { assetId: record.assetId, file: record.file, markdown: padFileMarkdown(record, widthArg), width: record.width, height: record.height, license: license ?? null },
        )
      }

      return fail('UNKNOWN_ACTION', `未知 action：${action}`, '可用：list / extract / plot / svg / url')
    }),
  }
}

