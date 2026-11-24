// LectureForge — 覆盖账本（ledger）状态机。纯逻辑，不碰磁盘。
// 每个素材块必须最终被 mapped 到至少一个章节（covered / merged / blocked）。
import { nowIso } from './paths.mjs'

export const BLOCK_STATUSES = ['covered', 'merged', 'blocked', 'pending']
export const CLAIM_STATUSES = ['covered', 'merged', 'blocked']
export const BLOCK_KINDS = [
  'exposition',
  'clarification',
  'derivation',
  'example',
  'verification',
  'exercise',
  'solution',
]

export function normalizeClaims(rawClaims) {
  if (!Array.isArray(rawClaims) || rawClaims.length === 0) {
    throw new ClaimError('EMPTY_CLAIMS', 'claims 必须是非空数组')
  }
  return rawClaims.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new ClaimError('INVALID_CLAIM', `claims[${index}] 必须是对象`)
    const blockId = String(raw.blockId ?? raw.id ?? '').trim()
    if (!blockId) throw new ClaimError('INVALID_CLAIM', `claims[${index}] 缺少 blockId`)
    const status = String(raw.status ?? 'covered').trim()
    if (!CLAIM_STATUSES.includes(status)) {
      throw new ClaimError('INVALID_STATUS', `claims[${index}] status 必须是 ${CLAIM_STATUSES.join(' / ')}`)
    }
    const sections = Array.isArray(raw.sections)
      ? raw.sections.map((s) => String(s).trim()).filter(Boolean)
      : raw.section
        ? [String(raw.section).trim()]
        : []
    const kinds = Array.isArray(raw.kinds)
      ? raw.kinds.map((k) => String(k).trim()).filter(Boolean)
      : raw.kinds
        ? [String(raw.kinds).trim()]
        : []
    return {
      blockId,
      status,
      sections: [...new Set(sections)],
      kinds: [...new Set(kinds)],
      mergeInto: raw.mergeInto ? String(raw.mergeInto).trim() : null,
      reason: raw.reason ? String(raw.reason).trim() : null,
      reviewed: raw.reviewed === true,
      index,
    }
  })
}

export class ClaimError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.name = 'ClaimError'
    this.code = code
    if (hint) this.hint = hint
  }
}

function unknownKinds(kinds) {
  return kinds.filter((k) => !BLOCK_KINDS.includes(k))
}

/**
 * 校验并应用一批 claim。
 * @param {object} ledger
 * @param {Array} claims normalizeClaims 的产物
 * @param {{blockIndex: Map, sectionIds: Set<string>}} ctx
 */
export function applyClaims(ledger, claims, ctx) {
  const { blockIndex, sectionIds: rawSectionIds } = ctx
  const sectionIds = rawSectionIds instanceof Set ? rawSectionIds : new Set(rawSectionIds ?? [])
  const errors = []
  const warnings = []
  const applied = []

  // 第一遍：先应用 covered，merged 才能引用本批新 covered 的块。
  const ordered = [...claims].sort((a, b) => Number(a.status === 'merged') - Number(b.status === 'merged'))

  for (const claim of ordered) {
    const entry = blockIndex.get(claim.blockId)
    if (!entry) {
      errors.push({
        code: 'UNKNOWN_BLOCK',
        blockId: claim.blockId,
        index: claim.index,
        message: `账本里没有素材块 ${claim.blockId}（检查来源编号与块号）`,
      })
      continue
    }
    // merged 的章节归属可以从合并目标继承，因此只有 covered 必须显式给出 sections。
    if (claim.sections.length === 0 && claim.status === 'covered') {
      errors.push({
        code: 'MISSING_SECTION',
        blockId: claim.blockId,
        index: claim.index,
        message: `${claim.blockId} 的 ${claim.status} 必须给出 sections`,
      })
      continue
    }
    const badSections = claim.sections.filter((id) => !sectionIds.has(id))
    if (badSections.length > 0) {
      errors.push({
        code: 'UNKNOWN_SECTION',
        blockId: claim.blockId,
        index: claim.index,
        message: `${claim.blockId} 引用了讲稿中不存在的章节：${badSections.join(', ')}`,
        hint: '章节 id 来自标题行尾的 {#sec-...} 标记，先写入 lecture.md 再 claim。',
      })
      continue
    }
    if (claim.kinds.length === 0) {
      errors.push({
        code: 'MISSING_KINDS',
        blockId: claim.blockId,
        index: claim.index,
        message: `${claim.blockId} 必须声明 kinds（${BLOCK_KINDS.join(' | ')}）`,
      })
      continue
    }
    const badKinds = unknownKinds(claim.kinds)
    if (badKinds.length > 0) {
      errors.push({
        code: 'UNKNOWN_KIND',
        blockId: claim.blockId,
        index: claim.index,
        message: `${claim.blockId} 的 kinds 含未知值：${badKinds.join(', ')}`,
      })
      continue
    }

    const previous = ledger.blocks[claim.blockId] ?? null
    if (claim.status === 'merged') {
      if (!claim.mergeInto) {
        errors.push({
          code: 'MISSING_MERGE_TARGET',
          blockId: claim.blockId,
          index: claim.index,
          message: `${claim.blockId} 标记 merged 时必须给出 mergeInto`,
        })
        continue
      }
      if (claim.mergeInto === claim.blockId) {
        errors.push({
          code: 'SELF_MERGE',
          blockId: claim.blockId,
          index: claim.index,
          message: `${claim.blockId} 不能合并到自己`,
        })
        continue
      }
      const target = ledger.blocks[claim.mergeInto]
      if (!target) {
        errors.push({
          code: 'UNKNOWN_MERGE_TARGET',
          blockId: claim.blockId,
          index: claim.index,
          message: `${claim.blockId} 的 mergeInto 目标 ${claim.mergeInto} 不在账本中`,
        })
        continue
      }
      if (target.status !== 'covered') {
        errors.push({
          code: 'MERGE_TARGET_NOT_COVERED',
          blockId: claim.blockId,
          index: claim.index,
          message: `${claim.blockId} 的合并目标 ${claim.mergeInto} 尚未 covered`,
        })
        continue
      }
      const sections = claim.sections.length > 0 ? claim.sections : target.sections ?? []
      if (sections.length === 0) {
        errors.push({
          code: 'MISSING_SECTION',
          blockId: claim.blockId,
          index: claim.index,
          message: `${claim.blockId} 合并后仍没有章节归属`,
        })
        continue
      }
      ledger.blocks[claim.blockId] = {
        ...(previous ?? {}),
        status: 'merged',
        sections: [...new Set(sections)],
        kinds: claim.kinds,
        mergeInto: claim.mergeInto,
        reason: null,
        reviewed: claim.reviewed || Boolean(previous?.reviewed),
        updatedAt: nowIso(),
      }
      applied.push({ blockId: claim.blockId, status: 'merged', sections, mergeInto: claim.mergeInto })
      continue
    }

    if (claim.status === 'blocked') {
      if (!claim.reason) {
        errors.push({
          code: 'MISSING_REASON',
          blockId: claim.blockId,
          index: claim.index,
          message: `${claim.blockId} 标记 blocked 时必须写明 reason`,
        })
        continue
      }
      ledger.blocks[claim.blockId] = {
        ...(previous ?? {}),
        status: 'blocked',
        sections: claim.sections,
        kinds: claim.kinds,
        mergeInto: null,
        reason: claim.reason,
        reviewed: claim.reviewed || Boolean(previous?.reviewed),
        updatedAt: nowIso(),
      }
      applied.push({ blockId: claim.blockId, status: 'blocked', sections: claim.sections })
      continue
    }

    ledger.blocks[claim.blockId] = {
      ...(previous ?? {}),
      status: 'covered',
      sections: claim.sections,
      kinds: claim.kinds,
      mergeInto: null,
      reason: null,
      reviewed: claim.reviewed || Boolean(previous?.reviewed),
      updatedAt: nowIso(),
    }
    applied.push({ blockId: claim.blockId, status: 'covered', sections: claim.sections })
  }

  if (applied.length === 0) warnings.push('本批 claim 没有一条被应用')
  return { ledger, applied, errors, warnings }
}

export function markReviewed(ledger, blockIds) {
  const errors = []
  const reviewed = []
  for (const blockId of blockIds) {
    if (!ledger.blocks[blockId]) {
      errors.push({ blockId, message: `账本里没有 ${blockId}，先 claim 再复核` })
      continue
    }
    ledger.blocks[blockId].reviewed = true
    ledger.blocks[blockId].updatedAt = nowIso()
    reviewed.push(blockId)
  }
  return { errors, reviewed }
}

export function unmappedFromLedger(ledger, sources) {
  const out = []
  for (const source of sources) {
    const blocks = []
    for (const block of source.blocks) {
      const status = ledger.blocks[block.id]?.status
      if (!status || status === 'pending') blocks.push(block)
    }
    if (blocks.length) out.push({ sourceId: source.sourceId, label: source.label, blocks })
  }
  return out
}

export function ledgerCounts(ledger) {
  const counts = { covered: 0, merged: 0, blocked: 0, pending: 0, reviewed: 0 }
  for (const record of Object.values(ledger.blocks ?? {})) {
    if (record?.status && Object.hasOwn(counts, record.status)) counts[record.status] += 1
    if (record?.reviewed) counts.reviewed += 1
  }
  return counts
}

/** 校验账本自身的一致性（不依赖讲稿）。 */
export function validateLedger(ledger) {
  const errors = []
  const blocks = ledger.blocks ?? {}
  for (const [blockId, record] of Object.entries(blocks)) {
    if (!record || typeof record !== 'object') {
      errors.push({ code: 'INVALID_RECORD', blockId, message: `${blockId} 的记录不是对象` })
      continue
    }
    if (!BLOCK_STATUSES.includes(record.status)) {
      errors.push({ code: 'INVALID_STATUS', blockId, message: `${blockId} 的状态非法：${record.status}` })
    }
    if (record.status === 'covered' && (!Array.isArray(record.sections) || record.sections.length === 0)) {
      errors.push({ code: 'MISSING_SECTION', blockId, message: `${blockId} 标记 covered 但没有章节` })
    }
    if (record.status === 'merged') {
      if (!record.mergeInto) {
        errors.push({ code: 'MISSING_MERGE_TARGET', blockId, message: `${blockId} 标记 merged 但没有 mergeInto` })
      } else {
        const target = blocks[record.mergeInto]
        if (!target) {
          errors.push({ code: 'UNKNOWN_MERGE_TARGET', blockId, message: `${blockId} 合并目标不存在` })
        } else if (target.status !== 'covered') {
          errors.push({
            code: 'MERGE_TARGET_NOT_COVERED',
            blockId,
            message: `${blockId} 合并目标 ${record.mergeInto} 不是 covered`,
          })
        }
      }
    }
    if (record.status === 'blocked' && !record.reason) {
      errors.push({ code: 'MISSING_REASON', blockId, message: `${blockId} 标记 blocked 但没有 reason` })
    }
  }
  return errors
}
