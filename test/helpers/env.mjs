// 测试用运行时探测：优先使用 DSH 自带 Python（含 numpy），否则退回 PATH。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const CANDIDATES = [
  process.env.DSH_PYTHON,
  path.join(
    process.env.USERPROFILE ?? '',
    '.dsh',
    'dsh-runtimes',
    'dsh-primary-runtime',
    'dependencies',
    'python',
    'python.exe',
  ),
  'python',
  'python3',
].filter(Boolean)

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
