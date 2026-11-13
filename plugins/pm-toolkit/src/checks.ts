/**
 * Fast document checks for the PM toolkit.
 *
 * These are deliberately heuristic: the point is to catch a missing section or
 * a vague promise before the document reaches review, not to judge prose.
 */

export type CheckKind = 'prd' | 'user_story' | 'launch_checklist' | 'status_update'

export interface CheckIssue {
  severity: 'error' | 'warning'
  message: string
  fix?: string
}

export interface CheckResult {
  ok: boolean
  kind: CheckKind
  issues: CheckIssue[]
}

interface RequiredSection {
  label: string
  pattern: RegExp
  fix: string
}

const PRD_SECTIONS: RequiredSection[] = [
  { label: '问题/背景', pattern: /(背景|问题|context|problem)/i, fix: 'Add a "背景与问题" section explaining why this work matters now.' },
  { label: '目标/指标', pattern: /(目标|成功指标|北極星|北极星|metric|goal|kpi)/i, fix: 'Add a goal and a measurable success metric.' },
  { label: '用户/场景', pattern: /(用户|场景|user|persona|scenario)/i, fix: 'Name the target users and the scenario they are in.' },
  { label: '范围/不做', pattern: /(范围|不做|non-goal|scope)/i, fix: 'State what is in scope and explicitly what is not.' },
  { label: '用户故事', pattern: /(用户故事|user story|作为.{0,20}我希望|as a .{0,40}i want)/i, fix: 'Add at least one user story.' },
  { label: '验收标准', pattern: /(验收|acceptance|given|假如|当.{0,12}那么)/i, fix: 'Add testable acceptance criteria, preferably Given/When/Then.' },
  { label: '风险/依赖', pattern: /(风险|依赖|risk|dependenc)/i, fix: 'List risks, dependencies and open questions.' },
  { label: '里程碑/计划', pattern: /(里程碑|计划|时间线|milestone|timeline|roadmap)/i, fix: 'Add milestones and a delivery horizon.' }
]

const USER_STORY_PATTERNS: Array<{ label: string; pattern: RegExp; fix: string }> = [
  { label: '角色', pattern: /(作为|as an?|as a )/i, fix: 'Start with "作为 <角色>" / "As a <role>".' },
  { label: '能力', pattern: /(我希望|我想要|I want|I need)/i, fix: 'State the capability the user wants.' },
  { label: '价值', pattern: /(以便|从而|so that|in order to)/i, fix: 'Explain the user value after "以便" / "so that".' },
  { label: '验收场景', pattern: /(given|when|then|假如|当|那么)/i, fix: 'Add at least one Given/When/Then acceptance scenario.' }
]

const LAUNCH_PATTERNS: Array<{ label: string; pattern: RegExp; fix: string }> = [
  { label: '回滚', pattern: /(回滚|rollback|roll back)/i, fix: 'Add a rollback plan and its trigger.' },
  { label: '监控', pattern: /(监控|告警|monitor|alert|dashboard)/i, fix: 'List the dashboards and alerts for launch day.' },
  { label: '负责人', pattern: /(负责人|owner|on-call|值班)/i, fix: 'Name the launch owner and on-call.' },
  { label: '客服/支持', pattern: /(客服|支持|support|faq)/i, fix: 'Prepare support FAQ and training.' },
  { label: '发布说明', pattern: /(发布说明|release note|公告|announcement)/i, fix: 'Draft the user-facing release notes.' }
]

const STATUS_PATTERNS: Array<{ label: string; pattern: RegExp; fix: string }> = [
  { label: '已完成', pattern: /(已完成|shipped|done|完成)/i, fix: 'Say what actually shipped.' },
  { label: '进行中', pattern: /(进行中|in progress|next)/i, fix: 'List work in progress and owners.' },
  { label: '风险/阻塞', pattern: /(风险|阻塞|risk|blocker)/i, fix: 'Surface risks and blockers explicitly.' },
  { label: '需要决策', pattern: /(决策|支持|ask|decision)/i, fix: 'State what decision or help is needed, from whom.' }
]

function missing(issues: CheckIssue[], patterns: Array<{ label: string; pattern: RegExp; fix: string }>, text: string): void {
  for (const item of patterns) {
    if (!item.pattern.test(text)) {
      issues.push({ severity: 'warning', message: `Missing ${item.label}.`, fix: item.fix })
    }
  }
}

export function checkDocument(kind: CheckKind, content: string): CheckResult {
  const text = content.trim()
  const issues: CheckIssue[] = []
  if (!text) {
    return {
      ok: false,
      kind,
      issues: [{ severity: 'error', message: 'Document is empty.', fix: 'Start from a template or paste the document content.' }]
    }
  }

  switch (kind) {
    case 'prd':
      missing(issues, PRD_SECTIONS, text)
      if (!/(验收|acceptance|given|when|then)/i.test(text)) {
        issues.push({
          severity: 'error',
          message: 'No acceptance criteria found.',
          fix: 'Add Given/When/Then criteria that another person could test.'
        })
      }
      if (/(尽快|适当|优化体验|提升体验|as soon as possible|better experience|etc\.)/i.test(text)) {
        issues.push({
          severity: 'warning',
          message: 'The document contains vague wording.',
          fix: 'Replace "尽快/适当/优化体验" with a measurable condition or a concrete behaviour.'
        })
      }
      break
    case 'user_story':
      missing(issues, USER_STORY_PATTERNS, text)
      if (!/(invest|independent|negotiable|valuable|estimable|small|testable)/i.test(text)) {
        issues.push({
          severity: 'warning',
          message: 'No INVEST check found.',
          fix: 'Add an INVEST checklist so the story is small and testable.'
        })
      }
      break
    case 'launch_checklist':
      missing(issues, LAUNCH_PATTERNS, text)
      if (!/(灰度|canary|rollout|发布策略)/i.test(text)) {
        issues.push({
          severity: 'warning',
          message: 'No rollout strategy found.',
          fix: 'Describe the canary percentage and criteria to expand or pause.'
        })
      }
      break
    case 'status_update':
      missing(issues, STATUS_PATTERNS, text)
      break
  }

  return { ok: !issues.some((issue) => issue.severity === 'error'), kind, issues }
}
