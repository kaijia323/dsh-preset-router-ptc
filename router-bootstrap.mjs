/**
 * router-bootstrap: task-aware reasoning-mode router with a continuous
 * react<->spec axis.
 *
 * Forked from dsh-preset-router-standard (router-standard, v0.3.0,
 * MIT), itself ported from https://github.com/yjh051108/dsh-routing-suite.
 *
 * Reads the session's first user message, classifies the task into a
 * continuous mode in [0,1] (0 = spec plan-first, 1 = react doer), and on the
 * first model request injects the matching persona and first-turn core tool
 * set. After the first durable tool/call the session is promoted to the
 * PTC/run_code presentation (Code Mode) by default, not the full native
 * Standard catalog; `promoteTo: standard` restores the old promotion. The
 * mode derives from durable session events, so resume/reload keeps it.
 *
 * The agent can read and tune its own routing through `dev_router_status` and
 * `dev_router_mode` (self-optimization loop) — mode accepts band names
 * (spec/spec-lean/balanced/react-lean/react), 0-100 numbers, or 0.0-1.0.
 *
 * PORT FIX (upstream issue #13): upstream stores the RAW first-message text in
 * `firstUserText` and reads it back as the mode, so `bandOf(text)` always
 * quantizes to `spec` and the weak-band near-field guidance never fires. Here
 * the captured text is classified with `classifyTask` before use, which is the
 * intended "first request carries the REAL classification" behavior.
 *
 * Zero external imports on purpose: relative preset rows resolve bare
 * specifiers from the user home, where `@deepseek-ai/*` is not installed.
 * The router tools therefore inline a minimal schema compiler instead of
 * importing `defineTool` from `@deepseek-ai/dsh-tools`.
 */

import {
  applyPersona, bandFor, bandOf, classifyTask, coreFor, parseMode, personaFor, sessionMode, testinessFor, clamp01,
  isComplexTask,
} from './router-core.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'router-bootstrap'

/** Prompt assembly, the tools registry, and the LLM route must exist. */
export const inject = ['systemPrompt', 'tools', 'llm']

/** Minimal spec -> JSON Schema compiler (subset of defineTool's work). */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (Array.isArray(meta.enum)) prop.enum = meta.enum
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/** Live mode for a session: explicit override, else the classified first
 *  real user message, else the durable-event derivation. */
function liveMode(overrides, firstUserText, session) {
  const override = overrides.get(session.id)
  if (override !== undefined) return override
  const live = firstUserText.get(session.id)
  if (live) return classifyTask(live)
  return sessionMode(session)
}

export function apply(ctx, config) {
  const overrides = new Map() // session id -> explicit mode (number 0..1)
  const agents = new Map() // session id -> Agent (live handle, in-process only)
  const firstUserText = new Map() // session id -> first REAL user message text (issue #3 fix)
  const codeModeAgents = new WeakSet() // agent -> already switched to PTC/run_code presentation
  const sdkInjectedSessions = new Set() // session id -> Code Mode SDK message already durable
  const sdkPendingSessions = new Set() // session id -> SDK message append queued, not yet durable

  // ── 路由模式（v0.2.0 命名，用户定义）───────────────────────────────────────
  // standard（默认，新）: RL 接口还原——首轮只有 RL 训练句 + shell/str_replace_editor，
  //   模型"想一段、做一段"（实测 25 步 / 24 工具调用 / 产出文件）。
  // spec（旧）: 深度思考优先——分类 persona（w7/REACT/SPEC）+ 保留全部 sections，
  //   模型首轮长思维链（101K 推理 0 行动是其特征，不是缺陷）。
  const routerMode = config.routerMode === 'spec' ? 'spec' : 'standard'
  // What the first-round promotion opens afterwards: `ptc` (default) switches
  // to the PTC/run_code (Code Mode) presentation; `standard` keeps the old
  // full native Standard catalog.
  const promoteTo = config.promoteTo === 'standard' ? 'standard' : 'ptc'
  const RL_PERSONA = 'You are a helpful software engineer assistant.'
  // PTC/run_code sessions reason about writing a program, which DeepSeek
  // otherwise tends to open with first-person singular "Let me ..." (the
  // preview-style voice). Keep the standard router persona but anchor the
  // reasoning voice to the collaborative style the standard preset exhibits
  // ("Let's ..." / "We need ...").
  const PTC_VOICE = 'You are working as part of a collaborative engineering team. In your reasoning, always use inclusive plural planning language ("Let\'s ...", "We need ..."). Never write the phrase "Let me" or the phrase "I need" anywhere in your reasoning; use "We need ..." or "Let\'s ..." instead.'

  /** spec 路由模式的首轮工具面（旧行为；weak 也走 default 面）。 */
  function legacyCore(mode) {
    switch (bandOf(mode)) {
      case 'spec': return ['read', 'edit', 'glob', 'grep']
      default: return ['read', 'write', 'edit']
    }
  }

  /** Render one registered prompt section for an agent. */
  function renderSectionText(section, agent) {
    if (section === undefined) return ''
    const text = typeof section.text === 'function' ? section.text({ scope: agent, agent }) : section.text
    return typeof text === 'string' ? text : ''
  }

  /** Stable identity of the Code Mode SDK message for one session. */
  function sdkMessageId(session) {
    return `ptc-sdk-${session.id}`
  }

  /** Whether the Code Mode SDK message is already durable (pending in the
   *  inbox or consumed into the message history), so resume/HMR never adds it
   *  twice and the system prompt can stay short on later assemblies. */
  function sdkInConversation(session) {
    if (sdkInjectedSessions.has(session.id)) return true
    const id = sdkMessageId(session)
    const found = (session.events || []).some((event) => {
      if (event.type === 'user/message' && event.data?.id === id) return true
      if (event.type !== 'agent/inbox/spliced') return false
      return (event.data?.inserted || []).some((message) => message.id === id)
    })
    if (found) sdkInjectedSessions.add(session.id)
    return found
  }

  /**
   * Move the generated Code Mode instructions OUT of the system prompt and
   * into a durable inbox message. `presentAs('code')` would otherwise keep a
   * ~33K `tools:sdk` section in `system` for every request; that long system
   * is what flips DeepSeek's reasoning voice to the preview-style "Let me...".
   * As a user message, the SDK is delivered once and the system prompt stays
   * the short router persona + voice, like the standard preset.
   */
  function injectSdkMessage(agent, session) {
    if (sdkInConversation(session) || sdkPendingSessions.has(session.id) || agent.inbox === undefined) return
    try {
      const tools = agent.ctx?.tools
      if (tools === undefined) return
      const codeOnly = renderSectionText(tools.collapseSection?.(), agent)
      const sdk = renderSectionText(tools.sdkSection?.(), agent)
      const body = [codeOnly, sdk].filter(Boolean).join('\n\n')
      if (!body.trim()) return
      const message = {
        id: sdkMessageId(session),
        role: 'user',
        source: { kind: 'plugin', plugin: name },
        content: [{ type: 'text', text: `<system-reminder>\nCode Mode instructions for this session:\n\n${body}\n</system-reminder>` }],
      }
      // `session/event` handlers run while the triggering session event is
      // still being published; `inbox.append` would reenter session append.
      // Queue the append as a microtask so it lands after publication but
      // before the agent loop claims the next-step inbox.
      sdkPendingSessions.add(session.id)
      queueMicrotask(() => {
        try {
          if (sdkInConversation(session)) return
          agent.inbox.append('next-step', message)
          sdkInjectedSessions.add(session.id)
        } catch (error) {
          ctx.logger?.warn?.(`${name}: could not inject PTC/run_code SDK message for session ${session.id}`, error)
        } finally {
          sdkPendingSessions.delete(session.id)
        }
      })
    } catch (error) {
      ctx.logger?.warn?.(`${name}: could not render PTC/run_code SDK message for session ${session.id}`, error)
    }
  }

  /**
   * Promote one agent to PTC/run_code presentation (the `code` preset's
   * tool-presentation mode) after its first durable tool/call. The switch is
   * per agent: it uses `agent.ctx` so only this session's model-facing tool
   * list collapses to the generated SDK's `run_code` entry point.
   */
  function promoteToPtc(agent, session) {
    if (codeModeAgents.has(agent)) return
    try {
      agent.ctx.tools.presentAs('code')
      codeModeAgents.add(agent)
    } catch (error) {
      const message = error && error.message ? String(error.message) : String(error)
      // Another presenter already put this agent into code mode (e.g. the
      // router plugin was HMR-reloaded while the agent's presentation stayed).
      // Treat that as success rather than retrying forever.
      if (/conflicts with|already declared|one composition selects one presentation/i.test(message)) {
        codeModeAgents.add(agent)
      } else {
        ctx.logger?.warn?.(`${name}: could not switch session ${session.id} to PTC/run_code presentation`, error)
        return
      }
    }
    injectSdkMessage(agent, session)
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const session = agent.session
    agents.set(session.id, agent)

    // issue #3 fix: the first assembly happens before the first user/message
    // event lands in session.events, so sessionMode() saw an empty transcript
    // and injected the WEAK band on the path-committing first request. Use the
    // live text captured by the session/event listener so the first request
    // carries the REAL classification (classifyTask applied, see PORT FIX).
    const mode = liveMode(overrides, firstUserText, session)
    const modelId = agent.options?.model

    // ── 模式分派 ──
    // standard（RL 接口还原）: 首轮 system = 只有 RL 训练句；身份/Web 定位/工具引导/
    // 规则 sections 全部移除（minimal 的 complete:true 语义，实测 46 字符 system →
    // 25 步迭代工作流）。
    // spec（深度思考优先）: 分类 persona + 保留全部 sections（首轮超长思维链是特征）。
    const planSection = (assembled.sections || []).find((s) => /plan/i.test(s.name))
    let sections
    let core
    let persona
    if (routerMode === 'standard') {
      persona = RL_PERSONA
      sections = planSection
        ? [planSection, { name: 'router-persona', text: persona, order: 0 }]
        : [{ name: 'router-persona', text: persona, order: 0 }]
      if (promoteTo === 'ptc') {
        sections = [...sections, { name: 'router-voice', text: PTC_VOICE, order: 1 }]
      }
      core = new Set(['str_replace_editor']) // RL shape: shell + editor
    } else {
      persona = personaFor(mode, modelId)
      sections = applyPersona(assembled.sections, persona) // keep all other sections
      core = new Set(legacyCore(mode))
    }

    // After promotion the system prompt keeps the SAME short shape as the
    // first turn (router persona + voice). The generated `tools:code-only`
    // and `tools:sdk` sections stay registered by `presentAs('code')`, but
    // their ~33K text is delivered once as a durable inbox message instead of
    // being rendered into `system` every request — that long system was the
    // thing flipping DeepSeek to the preview-style "Let me..." reasoning.
    const codeSections = (assembled.sections || []).filter(
      (section) => section.name === 'tools:code-only' || section.name === 'tools:sdk',
    )

    if (codeModeAgents.has(agent)) {
      // Normal path: the SDK message was injected on the first tool/call,
      // before this assembly, so the system prompt stays short.
      if (sdkInConversation(session)) {
        return { ...assembled, sections, contexts: [] }
      }
      // Rare fallback (e.g. promotion happened during this same assembly):
      // keep the SDK in the system for this one request; the injected inbox
      // message takes over from the next request.
      return { ...assembled, sections: [...sections, ...codeSections], contexts: [] }
    }

    if (session.events.some((event) => event.type === 'tool/call')) {
      if (routerMode === 'standard' && promoteTo === 'ptc') {
        promoteToPtc(agent, session)
        if (codeModeAgents.has(agent)) {
          return sdkInConversation(session)
            ? { ...assembled, sections, contexts: [] }
            : { ...assembled, sections: [...sections, ...codeSections], contexts: [] }
        }
      }
      return { ...assembled, sections, contexts: [] } // promoted: PTC/run_code (standard) / full catalog (spec)
    }

    const available = new Set(assembled.tools.map((tool) => tool.name))
    const shell = available.has('pwsh') ? 'pwsh' : available.has('bash') ? 'bash' : null
    if (shell === null) {
      throw new Error(`${name}: no platform shell in catalog`)
    }
    core.add(shell)

    return {
      ...assembled,
      sections,
      contexts: [],
      tools: assembled.tools.filter((tool) => core.has(tool.name)),
    }
  })

  // ── near-field routing guidance for weak mode (P14/P16/P17/P19/P20) ─────
  // Every REAL user message in a weak-mode session gets ONE fixed guidance
  // message appended to the inbox right after it (near field, cache-neutral).
  // v19: depth-adaptive — SIMPLE tasks get the fast-convergence guide;
  // COMPLEX tasks get the deep-exploration guide (depth-first, information-
  // driven stop signal). The persona carries no hard converge anchor
  // (P27: information-driven convergence beats step-driven; user feedback:
  // flash was over-confident / too shallow on complex tasks).
  const GUIDE_WEAK =
    '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply first, then commit and act.'
  const GUIDE_DEEP =
    '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply about the architecture, edge cases, and integration points. Do not spend reasoning on the environment or tooling. Produce when your information is complete. End each reasoning block with a decision or an information need.'

  ctx.on('session/event', (session, event) => {
    const data = event.data ?? {}
    // After the first durable tool/call, promote this session to PTC/run_code
    // mode instead of the full native Standard catalog.
    if (event.type === 'tool/call') {
      if (routerMode === 'standard' && promoteTo === 'ptc') {
        const agent = ctx.get('agent')
        const target = agent !== undefined && agent.session === session ? agent : [...agents.values()].find((a) => a.session === session)
        if (target !== undefined) promoteToPtc(target, session)
      }
      return
    }
    if (event.type !== 'user/message') return
    if (data.source?.kind !== 'user') return // only real user messages
    const text = extractText(data)
    if (!firstUserText.has(session.id) && text.trim()) {
      firstUserText.set(session.id, text.trim()) // issue #3: capture BEFORE assembly
    }
    const agent = ctx.get('agent')
    const target = agent !== undefined && agent.session === session ? agent : [...agents.values()].find((a) => a.session === session)
    if (target === undefined || target.inbox === undefined) return
    // On a resumed/continued session that already passed the first tool/call,
    // make sure the PTC/run_code presentation is active before the next assembly.
    if (routerMode === 'standard' && promoteTo === 'ptc' && session.events.some((event) => event.type === 'tool/call')) {
      promoteToPtc(target, session)
    }
    const mode = liveMode(overrides, firstUserText, session)
    if (bandOf(mode) !== 'weak') return // strong modes need no guidance
    if (!text.trim()) return
    const guide = isComplexTask(text) ? GUIDE_DEEP : GUIDE_WEAK
    try {
      target.inbox.append('next-step', {
        id: `router-guide-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        source: { kind: 'plugin', plugin: 'router-bootstrap' },
        content: [{ type: 'text', text: guide }],
      })
    } catch { /* duplicate/ordering races: skip */ }
  })

  // ── router visibility & tuning (agent self-optimization) ────────────────
  const registerTool = (tool) => {
    ctx.effect(() => ctx.tools.register({
      ...tool,
      parameters: toJsonSchema(tool.parameters),
      // output.schema is already a plain JSON Schema; keep it as-is
    }))
  }

  const modeSpec = {
    mode: {
      type: 'string',
      required: true,
      description: 'band name (spec / weak / mixed / react), a 0-100 number, a 0.0-1.0 number, or auto to clear the override',
    },
  }

  function fmtMode(mode) {
    return typeof mode === 'string' ? mode : mode.toFixed(2)
  }

  registerTool({
    name: 'dev_router_status',
    description: 'Show this session\'s reasoning-mode routing: mode, band, persona, first-turn core tools, test-suppression, tool presentation (native or ptc/run_code), and whether an override is active.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute() {
      const session = currentSession()
      if (session === undefined) return 'no agent session'
      const mode = overrides.get(session.id) ?? sessionMode(session)
      const agent = currentAgent()
      const modelId = agent?.options?.model
      return [
        `router-mode=${routerMode} (standard=RL接口还原 / spec=深度思考优先)`,
        `promote-to=${promoteTo} (ptc=run_code / standard=full native catalog)`,
        `mode=${fmtMode(mode)} (band=${bandFor(mode)})`,
        `persona=${personaFor(mode, modelId).replace(/\n/g, ' / ')}`,
        `core=[${coreFor(mode).join(', ')}]`,
        `testiness=${testinessFor(mode)}`,
        `presentation=${agent !== undefined && codeModeAgents.has(agent) ? 'ptc/run_code' : 'native'}`,
        `override=${overrides.has(session.id) ? 'yes' : 'no'}`,
      ].join('\n')
    },
  })

  registerTool({
    name: 'dev_router_mode',
    description: 'Set this session\'s reasoning mode: spec (plan-first) / weak (internal routing, model decides per task) / mixed (transition, trap) / react (doer). Accepts band names, 0-100, or 0.0-1.0; use auto to return to task classification. The next request applies it.',
    parameters: modeSpec,
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute(args) {
      const parsed = parseMode(args.mode)
      if (parsed === null) return `invalid mode "${args.mode}": use spec/weak/mixed/react, 0-100, 0.0-1.0, or auto`
      const session = currentSession()
      if (session === undefined) return 'no agent session'
      if (parsed === 'auto') overrides.delete(session.id)
      else overrides.set(session.id, parsed === 'weak' ? 'weak' : clamp01(parsed))
      const current = overrides.get(session.id) ?? sessionMode(session)
      return `mode=${fmtMode(current)} (band=${bandFor(current)}) — next request applies`
    },
  })

  // ── mode-isolated subagent: run a task in a DIFFERENT reasoning mode,
  //    without touching this session's trajectory (P6 showed tail persona
  //    is ineffective; DSH's native subagent inherits this persona, so the
  //    only working isolation is a fresh LLM call with its own system). ──
  registerTool({
    name: 'dev_mode_subagent',
    description: 'Run one task in a DIFFERENT reasoning mode than this session, in a fresh isolated context (own system prompt). The current session trajectory is untouched. Mode: spec (plan-first) / weak (internal routing) / react (doer) / balanced. Returns the subagent\'s answer text.',
    parameters: {
      mode: { type: 'string', required: true, description: 'spec / weak / react / balanced (or 0-100)' },
      task: { type: 'string', required: true, description: 'the task to hand to the mode-isolated subagent' },
      maxTokens: { type: 'number', description: 'output cap (default 1024)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const parsed = parseMode(args.mode)
      if (parsed === null || parsed === 'auto') return `invalid mode "${args.mode}"`
      const session = currentSession()
      const agent = session === undefined ? undefined : [...agents.values()].find((a) => a.session === session)
      if (agent === undefined || agent.options === undefined) return 'no agent route available'
      const { provider, model } = agent.options
      if (!provider || !model) return 'agent route missing provider/model'

      const persona = personaFor(parsed, model)
      const maxTokens = Number(args.maxTokens || 1024)
      let text = ''
      let reasoningChars = 0
      try {
        const stream = ctx.llm.stream({
          provider,
          model,
          system: persona,
          messages: [{ role: 'user', content: [{ type: 'text', text: String(args.task) }] }],
          maxTokens,
        })
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'reasoning-delta') reasoningChars += chunk.text.length
        }
      } catch (error) {
        return `subagent error: ${error && error.message ? error.message : String(error)}`
      }
      const head = text.slice(0, 3000)
      return `[mode-subagent ${bandFor(parsed)} | reasoning ${reasoningChars} chars]\n${head}${text.length > 3000 ? '\n…(truncated)' : ''}`
    },
  })

  function currentSession() {
    const agent = ctx.get('agent')
    if (agent !== undefined && agent.session !== undefined) return agent.session
    const last = [...agents.values()].at(-1)
    return last?.session
  }

  function currentAgent() {
    const session = currentSession()
    return session === undefined ? undefined : [...agents.values()].find((a) => a.session === session)
  }
}
