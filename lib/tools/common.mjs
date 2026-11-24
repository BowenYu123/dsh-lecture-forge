// LectureForge — 工具公共件：统一结果形状、错误包装、参数校验、输出渲染。
import { LectureError, resolveProjectDir, sessionCwd } from '../projects.mjs'

export function ok(message, extra = {}) {
  return { ok: true, message, ...extra }
}

export function fail(code, message, hint) {
  return { ok: false, code, message, ...(hint ? { hint } : {}) }
}

export function errorResult(error) {
  if (error instanceof LectureError) return fail(error.code, error.message, error.hint)
  const code = error?.code && typeof error.code === 'string' ? error.code : 'TOOL_ERROR'
  const message = String(error?.message ?? error)
  return fail(code, message, error?.hint)
}

export function wrap(handler) {
  return async (args, exec) => {
    try {
      return await handler(args ?? {}, exec)
    } catch (error) {
      return errorResult(error)
    }
  }
}

export function textOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: true,
    },
    render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
  }
}

function renderValue(value) {
  if (!value || typeof value !== 'object') return String(value ?? '')
  if (value.ok === false) {
    const hint = value.hint ? `\n提示：${value.hint}` : ''
    return `❌ ${value.code}: ${value.message}${hint}`
  }
  if (typeof value.message === 'string' && value.message.trim()) return value.message
  return JSON.stringify(value, null, 2)
}

export function requireString(args, key, { trim = true, max = 4000 } = {}) {
  const value = args[key]
  if (typeof value !== 'string' || (trim && !value.trim())) {
    throw new LectureError('MISSING_ARGUMENT', `参数 ${key} 必须是非空字符串`)
  }
  const out = trim ? value.trim() : value
  if (out.length > max) throw new LectureError('ARGUMENT_TOO_LONG', `参数 ${key} 超过 ${max} 字符`)
  return out
}

export function optionalString(args, key, { max = 4000 } = {}) {
  const value = args[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new LectureError('INVALID_ARGUMENT', `参数 ${key} 必须是字符串`)
  const out = value.trim()
  if (!out) return null
  return out.slice(0, max)
}

export function optionalInt(args, key, { min = -Infinity, max = Infinity, fallback = null } = {}) {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isInteger(n)) throw new LectureError('INVALID_ARGUMENT', `参数 ${key} 必须是整数`)
  if (n < min || n > max) throw new LectureError('INVALID_ARGUMENT', `参数 ${key} 必须在 ${min}..${max}`)
  return n
}

export function optionalBool(args, key, fallback = false) {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new LectureError('INVALID_ARGUMENT', `参数 ${key} 必须是布尔值`)
  return value
}

export function projectDir(exec, args) {
  return resolveProjectDir(exec, optionalString(args, 'project'))
}

export function cwdOf(exec) {
  return sessionCwd(exec)
}

/** 把多个 warning 行拼到 message 里，便于 agent 一眼看到。 */
export function withWarnings(message, warnings = []) {
  if (!warnings.length) return message
  return `${message}\n\n注意事项：\n${warnings.map((w) => `- ${w}`).join('\n')}`
}

export function toolSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}
