// LectureForge — 平台适配回归测试：macOS/Linux 的运行时探测不走 node.exe。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULTS, kitPaths } from '../lib/config.mjs'
import { tmpDir } from './helpers/env.mjs'

const NODE_NAME = process.platform === 'win32' ? 'node.exe' : 'node'
const CLI_REL = path.join(
  'app.asar.unpacked',
  'dsh',
  'node_modules',
  '@deepseek-ai',
  'libreoffice-kit',
  'lib',
  'cli.js',
)

function fakeResources({ withNode = true, withCli = true } = {}) {
  const root = tmpDir('resources')
  if (withNode) {
    const dir = path.join(root, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, NODE_NAME), '', 'utf8')
  }
  if (withCli) {
    const cli = path.join(root, CLI_REL)
    fs.mkdirSync(path.dirname(cli), { recursive: true })
    fs.writeFileSync(cli, '// fake libreoffice-kit cli\n', 'utf8')
  }
  return root
}

function withResources(root, fn) {
  const previous = process.env.DSH_RESOURCES
  process.env.DSH_RESOURCES = root
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.DSH_RESOURCES
    else process.env.DSH_RESOURCES = previous
  }
}

test('kitPaths：使用包内运行时 node（Windows node.exe，macOS/Linux node）', () => {
  const root = fakeResources()
  withResources(root, () => {
    const kit = kitPaths(DEFAULTS)
    assert.ok(kit, 'kitPaths 不应为 null')
    assert.equal(kit.node, path.join(root, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', NODE_NAME))
    assert.equal(kit.cli, path.join(root, CLI_REL))
    assert.equal(kit.ok, true)
    assert.equal(kit.electronAsNode, false)
  })
})

test('kitPaths：macOS/Linux 缺包内 node 时回退 Electron 并标记 electronAsNode', () => {
  if (process.platform === 'win32') return
  const root = fakeResources({ withNode: false })
  withResources(root, () => {
    const kit = kitPaths(DEFAULTS)
    assert.ok(kit)
    assert.equal(kit.node, process.execPath)
    assert.equal(kit.ok, true)
    assert.equal(kit.electronAsNode, true)
  })
})

test('kitPaths：显式 libreOfficeKitCli 保留 electronAsNode 语义', () => {
  const root = fakeResources({ withNode: false, withCli: true })
  const cli = path.join(root, CLI_REL)
  const previousNode = process.env.DSH_NODE
  delete process.env.DSH_NODE
  try {
    const kit = kitPaths({ ...DEFAULTS, libreOfficeKitCli: cli })
    assert.equal(kit.ok, true)
    assert.equal(kit.node, process.execPath)
    assert.equal(kit.electronAsNode, Boolean(process.versions.electron))
  } finally {
    if (previousNode === undefined) delete process.env.DSH_NODE
    else process.env.DSH_NODE = previousNode
  }
})
