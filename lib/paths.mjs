// LectureForge — 路径、读写与哈希工具。
// 所有项目产出一律落在项目根目录下的 `.lecture/`（工作区）与 `out/`（交付物）。
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ASSETS_DIR = path.join(PACKAGE_ROOT, 'assets')
export const VENDOR_DIR = path.join(ASSETS_DIR, 'vendor')
export const PY_DIR = path.join(PACKAGE_ROOT, 'py')
export const SKILL_DIR = path.join(PACKAGE_ROOT, 'skills', 'lecture-forge')
export const LECTURE_DIRNAME = '.lecture'
export const PLUGIN_VERSION = '0.1.0'

export function nowIso() {
  return new Date().toISOString()
}

export function projectPaths(root) {
  const lectureDir = path.join(root, LECTURE_DIRNAME)
  return {
    root,
    lectureDir,
    projectFile: path.join(lectureDir, 'project.json'),
    ledgerFile: path.join(lectureDir, 'ledger.json'),
    figuresFile: path.join(lectureDir, 'figures.json'),
    sourcesDir: path.join(lectureDir, 'sources'),
    rawDir: path.join(lectureDir, 'raw'),
    assetsDir: path.join(lectureDir, 'assets'),
    tmpDir: path.join(lectureDir, 'tmp'),
    buildDir: path.join(lectureDir, 'build'),
    lectureFile: path.join(lectureDir, 'lecture.md'),
    outDir: path.join(root, 'out'),
  }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

export function readJson(file, fallback) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT' && arguments.length >= 2) return fallback
    throw error
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`无法解析 JSON ${file}: ${error.message}`)
  }
}

function atomicWrite(file, data) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, data)
  try {
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch {}
    throw error
  }
}

export function writeJson(file, value) {
  atomicWrite(file, JSON.stringify(value, null, 2) + '\n')
}

export function writeText(file, text) {
  atomicWrite(file, String(text))
}

export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function sha256Text(text) {
  return sha256Buffer(Buffer.from(String(text), 'utf8'))
}

export function sha256File(file) {
  const hash = createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      hash.update(buf.subarray(0, n))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

export function copyFileTo(from, to) {
  ensureDir(path.dirname(to))
  fs.copyFileSync(from, to)
  return to
}

export function copyDir(from, to) {
  if (!exists(from)) return to
  ensureDir(to)
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dst)
    else if (entry.isFile()) fs.copyFileSync(src, dst)
  }
  return to
}

export function assertInside(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target))
  if (rel === '') return true
  if (path.isAbsolute(rel)) return false
  const norm = rel.split(path.sep).join('/')
  return norm !== '..' && !norm.startsWith('../')
}

export function relPosix(base, target) {
  return path.relative(base, target).split(path.sep).join('/')
}

export function fileUrl(file) {
  return pathToFileURL(path.resolve(file)).href
}

function expandHome(p) {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homedir(), p.slice(2))
  return p
}

/** 解析工具参数里的路径：相对路径以会话工作目录为基准。 */
export function resolveFromCwd(cwd, p) {
  const raw = expandHome(String(p ?? '').trim())
  if (!raw) throw Object.assign(new Error('路径为空'), { code: 'INVALID_PATH' })
  return path.resolve(cwd, raw)
}

/**
 * 输入素材路径围栏：允许工作区、用户目录、系统临时目录下的路径；
 * 其它位置必须由用户先复制进工作区（工具不会被用来当任意磁盘读取器）。
 */
export function resolveInputPath(cwd, p) {
  const abs = resolveFromCwd(cwd, p)
  const allowed = [cwd, homedir(), tmpdir()]
  if (!allowed.some((root) => assertInside(root, abs))) {
    throw Object.assign(
      new Error(`拒绝读取工作区/用户目录之外的路径：${abs}`),
      { code: 'PATH_OUTSIDE_WORKSPACE', hint: '请先把素材复制到工作区目录后重试。' },
    )
  }
  return abs
}

export function slugify(text, fallback = 'item') {
  const ascii = String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return ascii || fallback
}

export function safeFileBase(name, fallback = 'source') {
  const base = path.basename(String(name ?? ''), path.extname(String(name ?? '')))
  const cleaned = base
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || fallback).slice(0, 60)
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function listJsonFiles(dir) {
  if (!exists(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort()
    .map((name) => path.join(dir, name))
}

export function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function tail(text, limit = 2000) {
  const s = String(text ?? '')
  return s.length <= limit ? s : `…${s.slice(-limit)}`
}
