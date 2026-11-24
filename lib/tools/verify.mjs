// lecture_verify — 运行讲稿里的 Python 验证代码，或执行生成的 notebook。
import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { exists, ensureDir, assertInside, PY_DIR, VENDOR_DIR } from '../paths.mjs'
import { pythonEnv } from '../config.mjs'
import { LectureError, loadProject } from '../projects.mjs'
import { run } from '../runner.mjs'
import { executeNotebook } from '../render/ipynb.mjs'
import { ok, fail, optionalString, projectDir, textOutput, toolSchema, wrap } from './common.mjs'

class VerifyError extends LectureError {}

function pythonWithPaths() {
  const env = pythonEnv()
  const extra = [PY_DIR, path.join(VENDOR_DIR, 'py')]
  env.PYTHONPATH = [...extra, env.PYTHONPATH].filter(Boolean).join(path.delimiter)
  return env
}

function parseChecks(stdout) {
  const text = String(stdout ?? '').trim()
  if (!text) return null
  const lines = text.split(/\r?\n/).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.checks)) return parsed
    } catch {
      // 不是 JSON 行，继续找
    }
  }
  return null
}

export function makeVerifyTool(config, getRuntime) {
  return {
    name: 'lecture_verify',
    description:
      '验证讲义里的计算与代码：action=python 运行一个 .py 文件或一段代码并回传 stdout/stderr（可输出 {"checks":[…]} 结构化结果）；action=notebook 执行 out/lecture.ipynb 并返回逐单元结果。' +
      '用于核实推导中的数值、算法输出与 notebook 可运行性；失败会如实返回，不要绕过。',
    parameters: toolSchema(
      {
        project: { type: 'string', description: '项目目录（相对会话工作区，缺省=工作区根）' },
        action: { type: 'string', enum: ['python', 'notebook'], description: '验证类型' },
        file: { type: 'string', description: 'python：项目内的 .py 路径（相对项目根）' },
        code: { type: 'string', description: 'python：直接给出的代码（会写入 .lecture/tmp 后运行）' },
        notebook: { type: 'string', description: 'notebook：ipynb 路径（缺省 out/lecture.ipynb 或 .lecture/build/lecture.ipynb）' },
        timeoutMs: { type: 'integer', description: 'python：超时毫秒（缺省 120000）' },
      },
      ['action'],
    ),
    output: textOutput(),
    execute: wrap(async (args, exec) => {
      const root = projectDir(exec, args)
      const project = loadProject(root)
      if (!project) throw new LectureError('NO_PROJECT', '项目未初始化', '先调用 lecture_init')
      const runtime = await getRuntime()
      const python = runtime.python?.path
      if (!python) throw new VerifyError('PYTHON_MISSING', '找不到可用的 Python', '配置 pythonPath 或安装 Python 3.10+')
      const action = String(args.action ?? '')

      if (action === 'python') {
        const fileArg = optionalString(args, 'file', { max: 4096 })
        const code = optionalString(args, 'code', { max: 200000 })
        if (!fileArg && !code) return fail('MISSING_ARGUMENT', 'python 需要 file 或 code')
        let script
        if (fileArg) {
          const candidate = path.isAbsolute(fileArg) ? fileArg : path.resolve(root, fileArg)
          assertInside(root, candidate)
          if (!exists(candidate)) return fail('FILE_NOT_FOUND', `找不到验证脚本：${fileArg}`)
          if (!/\.py$/i.test(candidate)) return fail('INVALID_FILE', '验证脚本必须是 .py 文件')
          script = candidate
        } else {
          if (fileArg) return fail('INVALID_ARGUMENT', 'file 与 code 只能给一个')
          const tmpDir = ensureDir(path.join(root, '.lecture', 'tmp'))
          script = path.join(tmpDir, `verify-${Date.now()}.py`)
          await writeFile(script, code, 'utf8')
        }
        const timeoutMs = Number.isInteger(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 120000
        const result = await run(python, [script], {
          cwd: root,
          env: pythonWithPaths(),
          timeoutMs,
          signal: exec?.signal,
        })
        const checks = parseChecks(result.stdout)
        const success = result.code === 0 && !result.timedOut && !result.aborted
        const lines = [
          success ? `验证通过（${result.durationMs} ms）：${path.basename(script)}` : `验证失败：${path.basename(script)}`,
          `exit=${result.code}${result.timedOut ? ' (超时)' : ''}${result.aborted ? ' (中止)' : ''}`,
        ]
        if (result.stdout?.trim()) lines.push('', 'stdout:', '```', result.stdout.trim().slice(0, 6000), '```')
        if (result.stderr?.trim()) lines.push('', 'stderr:', '```', result.stderr.trim().slice(0, 6000), '```')
        if (checks) lines.push('', `结构化 checks：${checks.checks.length} 条`)
        if (!success) lines.push('', '把失败原因和修正写回讲稿；不要保留不能运行的代码。')
        const payload = {
          success,
          exitCode: result.code,
          timedOut: Boolean(result.timedOut),
          durationMs: result.durationMs,
          stdout: result.stdout,
          stderr: result.stderr,
          script,
          checks: checks?.checks ?? null,
        }
        if (!success) return { ...fail('VERIFY_FAILED', lines.join('\n')), ...payload }
        return ok(lines.join('\n'), payload)
      }

      if (action === 'notebook') {
        const candidates = [
          optionalString(args, 'notebook', { max: 4096 }),
          path.join('out', 'lecture.ipynb'),
          path.join('.lecture', 'build', 'lecture.ipynb'),
        ].filter(Boolean)
        let candidate = null
        for (const rel of candidates) {
          const abs = path.isAbsolute(rel) ? rel : path.resolve(root, rel)
          if (exists(abs)) {
            candidate = abs
            break
          }
        }
        if (!candidate) return fail('NO_NOTEBOOK', '找不到 notebook', '先用 lecture_build formats=["ipynb"] 生成')
        assertInside(root, candidate)
        let notebook
        try {
          notebook = JSON.parse(await readFile(candidate, 'utf8'))
        } catch (error) {
          throw new VerifyError('INVALID_NOTEBOOK', `读取 notebook 失败：${error?.message ?? error}`)
        }
        const result = await executeNotebook({
          notebook,
          pythonPath: python,
          cwd: root,
          pyDir: PY_DIR,
          cellTimeoutMs: config.cellTimeoutMs,
          totalTimeoutMs: config.notebookTimeoutMs,
          signal: exec?.signal,
        })
        const lines = [
          result.failed
            ? `Notebook 执行失败：${result.executed}/${notebook.cells?.length ?? '?'} 单元执行，${result.failed} 个失败`
            : `Notebook 执行完成：${result.executed} 个代码单元全部成功`,
          '单元结果：',
          ...result.cells.map((cell) =>
            `- #${cell.index} ${cell.ok ? 'ok' : `失败 ${cell.ename ?? ''}: ${String(cell.evalue ?? '').slice(0, 300)}`}${cell.timedOut ? '（超时）' : ''} ${cell.durationMs}ms`,
          ),
        ]
        if (result.warnings?.length) lines.push('', ...result.warnings.map((w) => `⚠ ${w}`))
        const payload = {
          executed: result.executed,
          failed: result.failed,
          cells: result.cells,
          warnings: result.warnings,
          notebook: path.relative(root, candidate),
        }
        if (result.failed) return { ...fail('NOTEBOOK_FAILED', lines.join('\n'), '修复对应单元后重新构建'), ...payload }
        return ok(lines.join('\n'), payload)
      }

      return fail('UNKNOWN_ACTION', `未知 action：${action}`, '可用：python / notebook')
    }),
  }
}
