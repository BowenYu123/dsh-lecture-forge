// LectureForge — 子进程执行器（超时、中止、输出上限、进程树清理）。
import { spawn, spawnSync } from 'node:child_process'

const LIVE = new Set()

export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 10000,
      })
      return
    }
    child.kill('SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch {}
  }
}

export function shutdownChildren() {
  for (const child of LIVE) killTree(child)
  LIVE.clear()
}

/**
 * 执行一个子进程，永不抛异常。
 * @returns {Promise<{code:number|null,signal:string|null,stdout:string,stderr:string,
 *   timedOut:boolean,aborted:boolean,truncated:boolean,spawnError:string|null,durationMs:number}>}
 */
export function run(command, args = [], options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 60000,
    signal,
    input = null,
    maxOutputBytes = 8 * 1024 * 1024,
    windowsHide = true,
  } = options
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const finish = (payload) => {
      clearTimeout(timer)
      resolve({
        code: payload.code ?? null,
        signal: payload.signal ?? null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        aborted,
        truncated,
        spawnError,
        durationMs: Date.now() - startedAt,
      })
    }
    let settled = false
    let done = (payload) => {
      if (settled) return
      settled = true
      finish(payload)
    }
    let child
    let timer = null
    let timedOut = false
    let aborted = false
    let truncated = false
    let spawnError = null
    const stdoutChunks = []
    const stderrChunks = []
    let outBytes = 0
    let errBytes = 0

    try {
      child = spawn(command, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      spawnError = String(error?.message ?? error)
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: false,
        truncated: false,
        spawnError,
        durationMs: Date.now() - startedAt,
      })
      return
    }
    LIVE.add(child)

    const collect = (chunks, chunk, which) => {
      const size = chunk.length
      if (which === 'out') {
        if (outBytes >= maxOutputBytes) { truncated = true; return }
        const slice = outBytes + size > maxOutputBytes ? chunk.subarray(0, maxOutputBytes - outBytes) : chunk
        chunks.push(Buffer.from(slice))
        outBytes += slice.length
        if (outBytes >= maxOutputBytes) truncated = true
      } else {
        if (errBytes >= maxOutputBytes) { truncated = true; return }
        const slice = errBytes + size > maxOutputBytes ? chunk.subarray(0, maxOutputBytes - errBytes) : chunk
        chunks.push(Buffer.from(slice))
        errBytes += slice.length
        if (errBytes >= maxOutputBytes) truncated = true
      }
    }

    child.stdout?.on('data', (chunk) => collect(stdoutChunks, chunk, 'out'))
    child.stderr?.on('data', (chunk) => collect(stderrChunks, chunk, 'err'))
    child.on('error', (error) => {
      spawnError = String(error?.message ?? error)
      done({ code: null, signal: null })
    })
    child.on('close', (code, signal) => {
      LIVE.delete(child)
      done({ code, signal })
    })

    if (input !== null && input !== undefined) {
      try {
        child.stdin.end(input)
      } catch {
        /* 子进程可能已退出 */
      }
    } else {
      try { child.stdin?.end() } catch {}
    }

    const onAbort = () => {
      aborted = true
      killTree(child)
      setTimeout(() => done({ code: null, signal: 'SIGKILL' }), 5000)
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        killTree(child)
        setTimeout(() => done({ code: null, signal: 'SIGKILL' }), 5000)
      }, timeoutMs)
      timer.unref?.()
    }
  })
}

export function runSync(command, args = [], options = {}) {
  try {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      windowsHide: true,
      timeout: options.timeoutMs ?? 20000,
      encoding: 'utf8',
      input: options.input,
    })
    return {
      ok: !result.error && result.status === 0,
      status: result.status,
      stdout: (result.stdout ?? '').trim(),
      stderr: (result.stderr ?? '').trim(),
      error: result.error ? String(result.error.message ?? result.error) : null,
    }
  } catch (error) {
    return { ok: false, status: null, stdout: '', stderr: '', error: String(error?.message ?? error) }
  }
}
