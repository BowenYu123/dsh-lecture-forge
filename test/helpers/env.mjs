// 测试用运行时探测：优先使用 DSH 自带 Python（含 numpy），否则退回 PATH。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// Windows 的 DSH 运行时是 python/python.exe，macOS / Linux 是 python/bin/python3。
const DSH_RUNTIME_PYTHON = path.join(
  os.homedir(),
  '.dsh',
  'dsh-runtimes',
  'dsh-primary-runtime',
  'dependencies',
  'python',
  process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python3'),
)

const CANDIDATES = [process.env.DSH_PYTHON, DSH_RUNTIME_PYTHON, 'python', 'python3'].filter(Boolean)

export const PYTHON = CANDIDATES.find((candidate) => {
  if (!candidate.includes(path.sep) && !candidate.includes('/')) return false
  return fs.existsSync(candidate)
}) ?? CANDIDATES[CANDIDATES.length - 1]

export const PYTHON_ENV = {
  PYTHONPATH: [path.join(ROOT, 'assets', 'vendor', 'py'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
}

export const NODE = process.execPath

export function fixture(name) {
  return path.join(ROOT, 'test', 'fixtures', name)
}

export function tmpDir(name) {
  const dir = path.join(ROOT, 'test', '.tmp', `${name}-${process.pid}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
