// LectureForge — 项目状态（project.json / sources / ledger / figures 的读写与统计）。
import fs from 'node:fs'
import path from 'node:path'
import {
  PLUGIN_VERSION,
  ensureDir,
  exists,
  listJsonFiles,
  nowIso,
  projectPaths,
  readJson,
  writeJson,
} from './paths.mjs'

export const SOURCE_KINDS = ['pdf', 'docx', 'pptx', 'md', 'html', 'url', 'txt']
export const FORMATS = ['pdf', 'html', 'ipynb', 'md']

export class LectureError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.name = 'LectureError'
    this.code = code
    if (hint) this.hint = hint
  }
}

export function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.trim()) return path.resolve(cwd)
  return process.cwd()
}

export function resolveProjectDir(exec, arg) {
  const cwd = sessionCwd(exec)
  if (arg === undefined || arg === null || arg === '') return cwd
  if (typeof arg !== 'string') throw new LectureError('INVALID_PATH', 'project 参数必须是字符串路径')
  return path.resolve(cwd, arg)
}

export function isInitialized(projectDir) {
  return exists(projectPaths(projectDir).projectFile)
}

export function requireProject(projectDir) {
  const project = loadProject(projectDir)
  if (!project) {
    throw new LectureError(
      'PROJECT_NOT_INITIALIZED',
      `${projectDir} 还没有 .lecture/project.json，请先调用 lecture_init。`,
    )
  }
  return project
}

export function loadProject(projectDir) {
  const p = projectPaths(projectDir)
  if (!exists(p.projectFile)) return null
  return readJson(p.projectFile)
}

export function saveProject(projectDir, project) {
  writeJson(projectPaths(projectDir).projectFile, project)
}

export function emptyLedger() {
  return { schemaVersion: 1, sections: [], blocks: {}, updatedAt: nowIso() }
}

export function loadLedger(projectDir) {
  const p = projectPaths(projectDir)
  if (!exists(p.ledgerFile)) return emptyLedger()
  const ledger = readJson(p.ledgerFile)
  if (!ledger.blocks || typeof ledger.blocks !== 'object') ledger.blocks = {}
  if (!Array.isArray(ledger.sections)) ledger.sections = []
  return ledger
}

export function saveLedger(projectDir, ledger) {
  ledger.updatedAt = nowIso()
  writeJson(projectPaths(projectDir).ledgerFile, ledger)
}

export function loadFigures(projectDir) {
  const p = projectPaths(projectDir)
  if (!exists(p.figuresFile)) return { schemaVersion: 1, assets: [] }
  const data = readJson(p.figuresFile)
  if (!Array.isArray(data.assets)) data.assets = []
  return data
}

export function saveFigures(projectDir, data) {
  writeJson(projectPaths(projectDir).figuresFile, data)
}

export function createProject(projectDir, input) {
  const p = projectPaths(projectDir)
  ensureDir(p.lectureDir)
  ensureDir(p.sourcesDir)
  ensureDir(p.rawDir)
  ensureDir(p.assetsDir)
  ensureDir(p.tmpDir)
  const formats = normalizeFormats(input.formats)
  const project = {
    schemaVersion: 1,
    id: makeProjectId(),
    title: input.title,
    goal: input.goal ?? '',
    subject: input.subject ?? 'general',
    learnerLevel: input.learnerLevel ?? 'undergraduate',
    language: input.language ?? 'zh',
    depth: input.depth ?? 'standard',
    formats,
    brief: {
      supplementary: normalizeList(input.brief?.supplementary),
      exercisesPerSection: clampInt(input.brief?.exercisesPerSection, 0, 50, 2),
      includeSolutions: input.brief?.includeSolutions !== false,
    },
    createdAt: nowIso(),
    updatedAt: nowIso(),
    pluginVersion: PLUGIN_VERSION,
  }
  saveProject(projectDir, project)
  const ledger = emptyLedger()
  saveLedger(projectDir, ledger)
  if (!exists(p.figuresFile)) saveFigures(projectDir, { schemaVersion: 1, assets: [] })
  if (!exists(p.lectureFile)) {
    fs.writeFileSync(p.lectureFile, starterLecture(project), 'utf8')
  }
  return { project, ledger }
}

export function normalizeFormats(formats) {
  const list = normalizeList(formats)
  const resolved = (list.length ? list : ['pdf']).map((f) => String(f).toLowerCase().trim())
  for (const f of resolved) {
    if (!FORMATS.includes(f)) {
      throw new LectureError('INVALID_FORMAT', `不支持输出格式 "${f}"，可用：${FORMATS.join(' / ')}`)
    }
  }
  return [...new Set(resolved)]
}

export function normalizeList(value) {
  if (value === undefined || value === null || value === '') return []
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(/[,，;；\n]/)
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return [String(value)]
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function makeProjectId() {
  const d = new Date()
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const rand = Math.random().toString(36).slice(2, 6)
  return `lf-${stamp}-${rand}`
}

function starterLecture(project) {
  const title = project.title || '未命名讲义'
  return `# ${title}\n\n> [!NOTE] 占位讲义\n> 这是 lecture_init 生成的骨架。先摄取素材、建立章节规划，再按 LectureForge 技能写入 \`.lecture/lecture.md\`。\n`
}

export function loadSources(projectDir) {
  const p = projectPaths(projectDir)
  return listJsonFiles(p.sourcesDir).map((file) => {
    const data = readJson(file)
    data.file = file
    if (!Array.isArray(data.blocks)) data.blocks = []
    return data
  })
}

export function saveSource(projectDir, source) {
  const file = path.join(projectPaths(projectDir).sourcesDir, `${source.sourceId}.json`)
  writeJson(file, source)
  return file
}

export function nextSourceId(existingIds) {
  let max = 0
  for (const id of existingIds) {
    const m = /^S(\d+)$/.exec(String(id))
    if (m) max = Math.max(max, Number.parseInt(m[1], 10))
  }
  return `S${String(max + 1).padStart(2, '0')}`
}

export function sourceBlockIndex(sources) {
  const index = new Map()
  for (const source of sources) {
    for (const block of source.blocks) index.set(block.id, { source, block })
  }
  return index
}

export function computeCoverage(project, sources, ledger) {
  const records = ledger?.blocks ?? {}
  const totals = { total: 0, blocks: 0, covered: 0, merged: 0, blocked: 0, pending: 0, reviewed: 0 }
  const perSource = []
  for (const source of sources) {
    const item = {
      sourceId: source.sourceId,
      label: source.label,
      kind: source.kind,
      total: source.blocks.length,
      blocks: source.blocks.length,
      covered: 0,
      merged: 0,
      blocked: 0,
      pending: 0,
      pages: {},
      lowTextPages: source.lowTextPages ?? [],
      warnings: source.warnings ?? [],
    }
    for (const block of source.blocks) {
      const record = records[block.id]
      const status = record?.status && ['covered', 'merged', 'blocked', 'pending'].includes(record.status)
        ? record.status
        : 'pending'
      item[status] += 1
      if (record?.reviewed) totals.reviewed += 1
      const pageKey = block.page ? String(block.page) : 'front'
      const page = (item.pages[pageKey] ??= { blocks: 0, covered: 0, merged: 0, blocked: 0, pending: 0 })
      page.blocks += 1
      page[status] += 1
    }
    for (const key of ['total', 'blocks', 'covered', 'merged', 'blocked', 'pending']) totals[key] += item[key]
    perSource.push(item)
  }
  const addressed = totals.covered + totals.merged
  return {
    ...totals,
    percent: totals.total ? Math.round((addressed / totals.total) * 100) : 0,
    perSource,
  }
}

export function visionPending(sources, ledger) {
  const records = ledger?.blocks ?? {}
  const pending = []
  for (const source of sources) {
    for (const page of source.lowTextPages ?? []) {
      const ok = source.blocks.some(
        (block) => block.page === page && block.kind === 'ocr' && records[block.id]?.reviewed === true,
      )
      if (!ok) pending.push({ sourceId: source.sourceId, page, label: source.label })
    }
  }
  return pending
}

export function unmappedBlocks(sources, ledger) {
  const records = ledger?.blocks ?? {}
  const out = []
  for (const source of sources) {
    for (const block of source.blocks) {
      const status = records[block.id]?.status
      if (!status || status === 'pending') out.push({ sourceId: source.sourceId, block })
    }
  }
  return out
}

export function blockExcerpt(block, limit = 160) {
  const text = String(block.text ?? '').replace(/\s+/g, ' ').trim()
  const short = text.length > limit ? `${text.slice(0, limit)}…` : text
  return {
    id: block.id,
    page: block.page ?? null,
    kind: block.kind,
    chars: block.chars ?? text.length,
    excerpt: short,
    crossPage: Boolean(block.crossPage),
    needsVision: Boolean(block.needsVision),
  }
}

export function sourceSummary(source) {
  return {
    sourceId: source.sourceId,
    label: source.label,
    kind: source.kind,
    origin: source.origin,
    blocks: source.blocks.length,
    pages: source.structure?.pages ?? null,
    figures: (source.figures ?? []).length,
    lowTextPages: source.lowTextPages ?? [],
    warnings: source.warnings ?? [],
  }
}

export function projectSummary(project) {
  return {
    id: project.id,
    title: project.title,
    subject: project.subject,
    learnerLevel: project.learnerLevel,
    language: project.language,
    depth: project.depth,
    formats: project.formats,
    brief: project.brief,
  }
}
