// lecture_init — 初始化讲义项目（.lecture/ 工作区）。
import path from 'node:path'
import { exists, ensureDir, formatBytes } from '../paths.mjs'
import { VENDOR_DIR } from '../paths.mjs'
import { describeRuntime } from '../config.mjs'
import { createProject, loadProject, loadSources, projectSummary, resolveProjectDir } from '../projects.mjs'
import { LectureError } from '../projects.mjs'
import { ok, optionalString, textOutput, toolSchema, wrap, withWarnings } from './common.mjs'

const FORMAT_ENUM = ['pdf', 'html', 'ipynb', 'md']
const LEVELS = ['highschool', 'undergraduate', 'graduate', 'researcher', 'mixed']
const DEPTHS = ['brief', 'standard', 'deep']

function vendorStatus() {
  const checks = {
    katex: exists(path.join(VENDOR_DIR, 'katex', 'katex.min.js')),
    markdownIt:
      exists(path.join(VENDOR_DIR, 'markdown-it', 'index.mjs')) ||
      exists(path.join(VENDOR_DIR, 'markdown-it', 'dist', 'markdown-it.js')),
    pypdf: exists(path.join(VENDOR_DIR, 'py', 'pypdf', '__init__.py')),
  }
  const missing = []
  if (!checks.katex) missing.push('KaTeX（assets/vendor/katex）缺失：公式将无法渲染')
  if (!checks.markdownIt) missing.push('markdown-it（assets/vendor/markdown-it）缺失：讲稿无法渲染')
  if (!checks.pypdf) missing.push('pypdf（assets/vendor/py/pypdf）缺失：PDF 摄取依赖系统 Python 的 pypdf')
  return { checks, missing }
}

export function makeInitTool(config) {
  return {
    name: 'lecture_init',
    description:
      '初始化 LectureForge 讲义项目：在工作目录下创建 .lecture/（project.json、ledger.json、lecture.md 骨架、sources/、assets/）。' +
      '幂等：已初始化的项目直接返回现有配置。之后用 lecture_ingest 摄取素材，用 lecture_ledger 建立覆盖账本，用 lecture_build 导出。',
    parameters: toolSchema(
      {
        project: {
          type: 'string',
          description: '项目目录（相对会话工作区；缺省=会话工作区根目录）。讲义产物写入 <project>/out/。',
        },
        title: { type: 'string', description: '讲义标题（必填）' },
        goal: { type: 'string', description: '学习目标/大致需求（例：为本科生系统讲解变分法与 Euler-Lagrange 方程）' },
        subject: { type: 'string', description: '学科，如 math / physics / cs / ee / general' },
        learnerLevel: { type: 'string', enum: LEVELS, description: '学习者水平' },
        language: { type: 'string', description: '讲义语言（缺省取插件配置 defaultLanguage，通常 zh）' },
        depth: { type: 'string', enum: DEPTHS, description: 'brief=精简提纲，standard=完整讲义，deep=推导密集+扩展' },
        formats: {
          type: 'array',
          items: { type: 'string', enum: FORMAT_ENUM },
          description: '默认输出格式；缺省 ["pdf"]。ipynb 会执行全部代码单元。',
        },
        brief: {
          type: 'object',
          description: '补充内容要求',
          properties: {
            supplementary: {
              type: 'array',
              items: { type: 'string' },
              description: '必须补充的额外内容桶，例：["historical-context","common-pitfalls","numerical-experiments","algorithm-pseudocode"]',
            },
            exercisesPerSection: { type: 'integer', description: '每节练习数量（0-50，缺省 2）' },
            includeSolutions: { type: 'boolean', description: '是否附练习解答（缺省 true）' },
          },
          additionalProperties: false,
        },
      },
      ['title'],
    ),
    output: textOutput(),
    execute: wrap(async (args, exec) => {
      const root = resolveProjectDir(exec, optionalString(args, 'project'))
      ensureDir(root)
      const existing = loadProject(root)
      const runtime = describeRuntime(config)
      const vendor = vendorStatus()
      if (existing) {
        const sources = loadSources(root)
        return ok(
          withWarnings(`项目已初始化：${existing.title}（${existing.id}）`, [...runtime.warnings, ...vendor.missing]),
          {
            initialized: false,
            projectDir: root,
            project: projectSummary(existing),
            sources: sources.length,
            paths: {
              lecture: path.join(root, '.lecture', 'lecture.md'),
              ledger: path.join(root, '.lecture', 'ledger.json'),
              sources: path.join(root, '.lecture', 'sources'),
              out: path.join(root, 'out'),
            },
            runtime,
          },
        )
      }

      const title = optionalString(args, 'title', { max: 200 })
      if (!title) throw new LectureError('MISSING_ARGUMENT', '参数 title 必填')
      const briefArg = args.brief && typeof args.brief === 'object' ? args.brief : {}
      const formats = Array.isArray(args.formats) ? args.formats : config.defaultLanguage ? ['pdf'] : ['pdf']
      const { project } = createProject(root, {
        title,
        goal: optionalString(args, 'goal', { max: 4000 }) ?? '',
        subject: optionalString(args, 'subject', { max: 80 }) ?? 'general',
        learnerLevel: LEVELS.includes(args.learnerLevel) ? args.learnerLevel : 'undergraduate',
        language: optionalString(args, 'language', { max: 20 }) ?? config.defaultLanguage,
        depth: DEPTHS.includes(args.depth) ? args.depth : 'standard',
        formats,
        brief: {
          supplementary: briefArg.supplementary,
          exercisesPerSection: briefArg.exercisesPerSection,
          includeSolutions: briefArg.includeSolutions,
        },
      })
      const lines = [
        `已创建讲义项目「${project.title}」（${project.id}）于 ${root}`,
        `格式：${project.formats.join(' / ')}｜语言：${project.language}｜深度：${project.depth}｜学习者：${project.learnerLevel}`,
        '',
        '工作区文件：',
        '- `.lecture/lecture.md`：讲义正文（你的主要写作目标，标题尾用 {#sec-...} 标注章节 id）',
        '- `.lecture/ledger.json`：素材覆盖账本（lecture_ledger 维护）',
        '- `.lecture/sources/`：每个素材的规范化块',
        '- `.lecture/assets/`：图片资产',
        '- `out/`：交付物',
        '',
        '建议下一步：',
        '1. 对每个输入调用 `lecture_ingest`（action=source，source=文件路径或 URL），检查 blockCount / lowTextPages。',
        '2. 用 `lecture_ledger action=next` 逐批读取未覆盖块，规划章节并写入 lecture.md。',
        '3. 写入内容后用 `lecture_ledger action=claim-batch` 回填块到章节，正文保留 [S01, p.3] 来源标记。',
        '4. 用 `lecture_figure` 生成/登记图，`lecture_build` 导出，`lecture_audit` 审计。',
      ]
      const warnings = [...runtime.warnings, ...vendor.missing]
      return ok(withWarnings(lines.join('\n'), warnings), {
        initialized: true,
        projectDir: root,
        project: projectSummary(project),
        paths: {
          lecture: path.join(root, '.lecture', 'lecture.md'),
          ledger: path.join(root, '.lecture', 'ledger.json'),
          sources: path.join(root, '.lecture', 'sources'),
          out: path.join(root, 'out'),
        },
        runtime,
        vendor: vendor.checks,
        limits: {
          maxPages: config.maxPages,
          lowTextCharThreshold: config.lowTextCharThreshold,
          maxFileBytes: `${formatBytes(config.maxFileBytes)}`,
        },
      })
    }),
  }
}
