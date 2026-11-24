// 插件装配测试：7 个工具 + 内置技能在 apply 时注册（不依赖真实 Host）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../index.js'

function makeContext() {
  const tools = []
  const skills = []
  const effects = []
  const ctx = {
    effect(fn, label) {
      effects.push(label)
      return fn()
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['skills'])
      callback({
        effect(fn) {
          return fn()
        },
        skills: {
          register(skill) {
            skills.push(skill)
            return () => {}
          },
        },
      })
    },
  }
  return { ctx, tools, skills, effects }
}

test('apply：注册 7 个 lecture_* 工具与 lecture-forge 技能', () => {
  const { ctx, tools, skills } = makeContext()
  apply(ctx, {})
  assert.equal(name, 'dsh-lecture-forge')
  assert.deepEqual(inject, ['tools'])
  const names = tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, [
    'lecture_audit',
    'lecture_build',
    'lecture_figure',
    'lecture_ingest',
    'lecture_init',
    'lecture_ledger',
    'lecture_verify',
  ])
  for (const tool of tools) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(typeof tool.output.render, 'function')
  }
  assert.equal(skills.length, 1)
  const skill = skills[0]
  assert.equal(skill.name, 'lecture-forge')
  assert.equal(skill.source, 'bundled')
  assert.match(skill.content, /LectureForge/)
  assert.ok(!skill.content.startsWith('---'), 'frontmatter 应被剥离')
  assert.equal(skill.invocation.modelInvocable, true)
  assert.equal(skill.resourceBase.kind, 'directory')
})

test('Config：未知键与非法类型被拒绝', async () => {
  const { resolveConfig, ConfigError } = await import('../lib/config.mjs')
  assert.throws(() => resolveConfig({ nope: 1 }), (error) => error instanceof ConfigError)
  assert.throws(() => resolveConfig({ maxPages: -3 }), (error) => error instanceof ConfigError)
  const config = resolveConfig({ maxPages: 12, strictLicensing: false })
  assert.equal(config.maxPages, 12)
  assert.equal(config.strictLicensing, false)
  assert.equal(typeof config.lowTextCharThreshold, 'number')
})
