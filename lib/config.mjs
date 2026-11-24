// LectureForge — 配置与运行时发现（Python / 无头 Chromium / LibreOffice Kit）。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { VENDOR_DIR, exists } from './paths.mjs'

export const DEFAULTS = Object.freeze({
  pythonPath: null,
  chromiumPath: null,
  libreOfficeKitCli: null,
  maxPages: 400,
  maxFileBytes: 200 * 1024 * 1024,
  lowTextCharThreshold: 80,
  visionQueueLimit: 5,
  strictLicensing: true,
  defaultLanguage: 'zh',
  buildTimeoutMs: 180000,
  cellTimeoutMs: 60000,
  notebookTimeoutMs: 600000,
  qaPages: 6,
  qaDpi: 144,
  keepRawSources: true,
})

const NUMBER_RULES = {
  maxPages: { min: 1, max: 5000, int: true },
  maxFileBytes: { min: 1024, max: 8 * 1024 * 1024 * 1024, int: true },
  lowTextCharThreshold: { min: 0, max: 100000, int: true },
  visionQueueLimit: { min: 0, max: 500, int: true },
  buildTimeoutMs: { min: 1000, max: 3600000, int: true },
  cellTimeoutMs: { min: 1000, max: 3600000, int: true },
  notebookTimeoutMs: { min: 1000, max: 7200000, int: true },
  qaPages: { min: 0, max: 100, int: true },
  qaDpi: { min: 36, max: 600, int: true },
}

const BOOLEAN_KEYS = ['strictLicensing', 'keepRawSources']
const STRING_KEYS = ['defaultLanguage']
const NULLABLE_PATH_KEYS = ['pythonPath', 'chromiumPath', 'libreOfficeKitCli']

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
    this.code = 'INVALID_CONFIG'
  }
}

export function resolveConfig(raw = {}) {
  if (raw === null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('插件配置必须是对象')
  }
  const cfg = { ...DEFAULTS }
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in DEFAULTS)) throw new ConfigError(`未知配置项：${key}`)
    if (value === undefined || value === null) {
      if (NULLABLE_PATH_KEYS.includes(key) || key === 'defaultLanguage') {
        cfg[key] = value === null ? (key === 'defaultLanguage' ? DEFAULTS[key] : null) : cfg[key]
        continue
      }
      throw new ConfigError(`配置项 ${key} 不能为 null/undefined`)
    }
    if (NUMBER_RULES[key]) {
      const rule = NUMBER_RULES[key]
      if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new ConfigError(`配置项 ${key} 必须是数字`)
      }
      if (rule.int && !Number.isInteger(value)) throw new ConfigError(`配置项 ${key} 必须是整数`)
      if (value < rule.min || value > rule.max) {
        throw new ConfigError(`配置项 ${key} 必须在 ${rule.min}..${rule.max} 之间`)
      }
      cfg[key] = value
      continue
    }
    if (BOOLEAN_KEYS.includes(key)) {
      if (typeof value !== 'boolean') throw new ConfigError(`配置项 ${key} 必须是布尔值`)
      cfg[key] = value
      continue
    }
    if (STRING_KEYS.includes(key)) {
      if (typeof value !== 'string' || !value.trim()) throw new ConfigError(`配置项 ${key} 必须是非空字符串`)
      cfg[key] = value.trim()
      continue
    }
    if (NULLABLE_PATH_KEYS.includes(key)) {
      if (typeof value !== 'string') throw new ConfigError(`配置项 ${key} 必须是字符串路径`)
      cfg[key] = value
      continue
    }
    cfg[key] = value
  }
  return cfg
}

function trySpawn(command, args, { timeoutMs = 20000, env } = {}) {
  try {
    const result = spawnSync(command, args, {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'utf8',
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const ok = !result.error && result.status === 0
    return {
      ok,
      status: result.status,
      stdout: (result.stdout ?? '').trim(),
      stderr: (result.stderr ?? '').trim(),
      error: result.error ? String(result.error.message ?? result.error) : null,
    }
  } catch (error) {
    return { ok: false, status: null, stdout: '', stderr: '', error: String(error?.message ?? error) }
  }
}

export function vendorPythonPath() {
  return path.join(VENDOR_DIR, 'py')
}

export function pythonEnv(extra = {}) {
  const pyPath = vendorPythonPath()
  const current = process.env.PYTHONPATH
  const joined = current ? `${pyPath}${path.delimiter}${current}` : pyPath
  return {
    PYTHONPATH: joined,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    ...extra,
  }
}

function pythonCandidates(config) {
  const out = []
  if (config.pythonPath) out.push(config.pythonPath)
  if (process.env.DSH_PYTHON) out.push(process.env.DSH_PYTHON)
  const runtimes = path.join(homedir(), '.dsh', 'dsh-runtimes')
  if (exists(runtimes)) {
    for (const entry of fs.readdirSync(runtimes)) {
      // Windows 的 DSH 运行时是 python/python.exe，macOS / Linux 是 python/bin/python3。
      const dir = path.join(runtimes, entry, 'dependencies', 'python')
      const names =
        process.platform === 'win32'
          ? ['python.exe']
          : [path.join('bin', 'python3'), path.join('bin', 'python')]
      for (const name of names) {
        const p = path.join(dir, name)
        if (exists(p)) out.push(p)
      }
    }
  }
  if (process.platform === 'win32') {
    const localPrograms = path.join(homedir(), 'AppData', 'Local', 'Programs', 'Python')
    if (exists(localPrograms)) {
      for (const entry of fs.readdirSync(localPrograms)) {
        const p = path.join(localPrograms, entry, 'python.exe')
        if (exists(p)) out.push(p)
      }
    }
  } else {
    // macOS（Homebrew / 系统）与 Linux 的常见位置。
    out.push('/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3')
  }
  out.push('python', 'python3')
  return [...new Set(out)]
}

function probePython(config) {
  for (const candidate of pythonCandidates(config)) {
    if (candidate.includes(path.sep) || candidate.includes('/')) {
      if (!exists(candidate)) continue
    }
    const probe = trySpawn(
      candidate,
      ['-c', 'import sys, json; print(json.dumps({"version": sys.version.split()[0], "exe": sys.executable}))'],
      { timeoutMs: 20000, env: pythonEnv() },
    )
    if (!probe.ok) continue
    let version = null
    let exe = candidate
    try {
      const parsed = JSON.parse(probe.stdout.split('\n').filter(Boolean).pop())
      version = parsed.version ?? null
      exe = parsed.exe ?? candidate
    } catch {
      version = null
    }
    const numpy = trySpawn(candidate, ['-c', 'import numpy; print(numpy.__version__)'], {
      timeoutMs: 30000,
      env: pythonEnv(),
    })
    const pypdf = trySpawn(candidate, ['-c', 'import pypdf; print(pypdf.__version__)'], {
      timeoutMs: 20000,
      env: pythonEnv(),
    })
    return {
      path: exe,
      command: candidate,
      version,
      hasNumpy: numpy.ok,
      numpyVersion: numpy.ok ? numpy.stdout.split('\n').filter(Boolean).pop() : null,
      hasPypdf: pypdf.ok,
      pypdfVersion: pypdf.ok ? pypdf.stdout.split('\n').filter(Boolean).pop() : null,
    }
  }
  return null
}

function chromiumCandidates(config) {
  const out = []
  if (config.chromiumPath) out.push(config.chromiumPath)
  if (process.env.DSH_CHROMIUM) out.push(process.env.DSH_CHROMIUM)
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local')
  if (process.platform === 'win32') {
    out.push(
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    )
  } else if (process.platform === 'darwin') {
    out.push(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
  } else {
    out.push('/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser')
  }
  return [...new Set(out)]
}

function probeChromium(config) {
  for (const candidate of chromiumCandidates(config)) {
    if (exists(candidate)) return { path: candidate }
  }
  return null
}

function resourcesRoot() {
  if (process.resourcesPath) return process.resourcesPath
  if (process.env.DSH_RESOURCES) return process.env.DSH_RESOURCES
  const exeDir = path.dirname(process.execPath ?? '')
  if (exeDir) {
    const guess = path.join(exeDir, 'resources')
    if (exists(guess)) return guess
  }
  return null
}

export function kitPaths(config) {
  if (config.libreOfficeKitCli) {
    const cli = config.libreOfficeKitCli
    const node = process.env.DSH_NODE || process.execPath
    return {
      node,
      cli,
      ok: exists(cli) && exists(node),
      // 未显式指定 DSH_NODE 时 node 是 Electron 二进制，调用方需要 ELECTRON_RUN_AS_NODE=1。
      electronAsNode: !process.env.DSH_NODE && Boolean(process.versions.electron),
    }
  }
  const resources = resourcesRoot()
  if (!resources) return null
  // Windows 的运行时 node 叫 node.exe；macOS / Linux 的包内运行时是 node。
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
  const node = path.join(resources, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', nodeName)
  const cli = path.join(
    resources,
    'app.asar.unpacked',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'libreoffice-kit',
    'lib',
    'cli.js',
  )
  const nodeOk = exists(node)
  const cliOk = exists(cli)
  if (!cliOk && !nodeOk) return null
  // macOS / Linux 若没有独立 node，回退到 Electron（配合 ELECTRON_RUN_AS_NODE=1）。
  const electronAsNode = !nodeOk && process.platform !== 'win32'
  return {
    node: nodeOk ? node : process.execPath,
    cli,
    ok: cliOk && (nodeOk || electronAsNode),
    electronAsNode,
  }
}

let cached = null
let cachedKey = null

export function probeRuntime(config, { refresh = false } = {}) {
  const key = JSON.stringify([
    config.pythonPath,
    config.chromiumPath,
    config.libreOfficeKitCli,
    process.env.DSH_PYTHON ?? null,
    process.env.DSH_CHROMIUM ?? null,
    process.env.DSH_RESOURCES ?? null,
  ])
  if (!refresh && cached && cachedKey === key) return cached
  const warnings = []
  const python = probePython(config)
  if (!python) {
    warnings.push(
      '未找到可用的 Python 解释器：PDF/网页/OCR 摄取与 notebook 执行将不可用，请在配置里指定 pythonPath。',
    )
  } else {
    if (!python.hasNumpy) warnings.push('当前 Python 没有 numpy：绘图与 notebook 计算单元可能失败。')
    if (!python.hasPypdf) warnings.push('当前 Python 没有 pypdf：将使用插件内置的 pypdf（assets/vendor/py）。')
  }
  const chromium = probeChromium(config)
  if (!chromium) warnings.push('未找到 Edge/Chrome：PDF 导出将不可用，请在配置里指定 chromiumPath。')
  const kit = kitPaths(config)
  if (!kit?.ok) warnings.push('未找到 LibreOffice Kit：PDF 页栅格化与 QA 缩略图不可用。')
  cached = { python, chromium, kit, warnings, tmpDir: tmpdir() }
  cachedKey = key
  return cached
}

export function describeRuntime(config) {
  const runtime = probeRuntime(config)
  return {
    python: runtime.python
      ? {
          path: runtime.python.path,
          version: runtime.python.version,
          numpy: runtime.python.numpyVersion,
          pypdf: runtime.python.pypdfVersion,
        }
      : null,
    chromium: runtime.chromium?.path ?? null,
    libreOfficeKit: runtime.kit ? { node: runtime.kit.node, cli: runtime.kit.cli, ok: runtime.kit.ok } : null,
    warnings: runtime.warnings,
  }
}
