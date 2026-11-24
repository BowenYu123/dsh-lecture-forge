// LectureForge — 学术素材 → 全覆盖、可追溯、带推导与可运行代码的学习讲义。
// Host-only 插件入口：注册 7 个 lecture_* 工具 + 内置技能 lecture-forge。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { probeRuntime, resolveConfig } from './lib/config.mjs'
import { SKILL_DIR } from './lib/paths.mjs'
import { shutdownChildren } from './lib/runner.mjs'
import { makeInitTool } from './lib/tools/init.mjs'
import { makeIngestTool } from './lib/tools/ingest.mjs'
import { makeLedgerTool } from './lib/tools/ledger.mjs'
import { makeFigureTool } from './lib/tools/figure.mjs'
import { makeBuildTool } from './lib/tools/build.mjs'
import { makeVerifyTool } from './lib/tools/verify.mjs'
import { makeAuditTool } from './lib/tools/audit.mjs'

export const name = 'dsh-lecture-forge'
export const inject = ['tools']

const SKILL_NAME = 'lecture-forge'
const SKILL_DESCRIPTION =
  '把论文、教材、讲义、网页或扫描件制成全覆盖、可追溯、带推导、配图与可运行代码的学习讲义，并导出 PDF / HTML / ipynb / Markdown。'

/** 读取技能正文（SKILL.md 去掉 YAML frontmatter）。 */
function readSkillBody(skillPath) {
  const raw = readFileSync(skillPath, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  return match ? raw.slice(match[0].length).trim() : raw.trim()
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config ?? {})
  const getRuntime = () => probeRuntime(resolved)

  const tools = [
    makeInitTool(resolved, getRuntime),
    makeIngestTool(resolved, getRuntime),
    makeLedgerTool(resolved, getRuntime),
    makeFigureTool(resolved, getRuntime),
    makeBuildTool(resolved, getRuntime),
    makeVerifyTool(resolved, getRuntime),
    makeAuditTool(resolved, getRuntime),
  ]
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `lecture-forge: tool ${tool.name}`)
  }

  ctx.inject(['skills'], (skillCtx) => {
    const skillPath = path.join(SKILL_DIR, 'SKILL.md')
    let content
    try {
      content = readSkillBody(skillPath)
    } catch {
      return
    }
    skillCtx.effect(
      () =>
        skillCtx.skills.register({
          name: SKILL_NAME,
          description: SKILL_DESCRIPTION,
          whenToUse:
            '用户给定论文/教材/讲义/网页并要求生成学习讲义、讲解材料、复习提纲、教学笔记、带推导或可运行代码的教程时，或明确要求“生成讲义/lecture/学习材料”时。',
          source: 'bundled',
          path: skillPath,
          resourceBase: { kind: 'directory', path: SKILL_DIR },
          content,
          invocation: { modelInvocable: true, userInvocable: true },
        }),
      `lecture-forge: skill ${SKILL_NAME}`,
    )
  })

  ctx.effect(() => () => shutdownChildren(), 'lecture-forge: subprocess cleanup')
}
