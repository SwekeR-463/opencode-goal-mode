import test from "node:test"
import assert from "node:assert/strict"
import plugin, { isGoalState, parseGoalCommand } from "../src/index.ts"

type Ctx = Parameters<typeof plugin.setup>[0]

const MARKER = "[[GOAL_STATUS_ONLY]]"

function makeHarness() {
  const store = new Map<string, unknown>()
  const prompts: Array<Record<string, any>> = []
  const synthetics: Array<Record<string, any>> = []
  const events: Array<Record<string, any>> = []
  let messages: Array<Record<string, any>> = []
  let sessionLocation = "/test/workspace"
  let contextHook: ((event: any) => unknown) | undefined
  let command: { execute: (input: any) => Promise<void> } | undefined
  const waiters: Array<() => void> = []
  const wake = () => waiters.splice(0).forEach((resolve) => resolve())

  const ctx = {
    location: { directory: "/test/workspace" },
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
    },
    session: {
      get: async (_input?: unknown) => ({ location: { directory: sessionLocation } }),
      hook: async (name: string, callback: (event: any) => unknown) => {
        if (name === "context") contextHook = callback
        return { dispose: async () => {} }
      },
      prompt: async (input: Record<string, any>) => void prompts.push(input),
      context: async () => messages,
      synthetic: async (input: Record<string, any>) => void synthetics.push(input),
    },
    command: {
      transform: async (callback: (editor: any) => void) => {
        callback({
          add: (definition: any) => {
            if (definition.name === "goal") command = definition
          },
        })
        return { dispose: async () => {} }
      },
    },
    event: {
      subscribe: async function* (options?: { signal?: AbortSignal }) {
        const signal = options?.signal
        const onAbort = () => wake()
        signal?.addEventListener("abort", onAbort)
        try {
          while (!signal?.aborted) {
            if (events.length === 0) await new Promise<void>((resolve) => waiters.push(resolve))
            if (signal?.aborted) return
            const event = events.shift()
            if (event) yield event
          }
        } finally {
          signal?.removeEventListener("abort", onAbort)
        }
      },
    },
  }

  return {
    ctx: ctx as unknown as Ctx,
    store,
    prompts,
    synthetics,
    push: (event: Record<string, any>) => {
      events.push(event)
      wake()
    },
    setMessages: (next: Array<Record<string, any>>) => {
      messages = next
    },
    setSessionLocation: (dir: string) => {
      sessionLocation = dir
    },
    goal: () => store.get("goal/s1") as Record<string, any> | undefined,
    contextHook: () => contextHook,
    run: (text: string) => command!.execute({ sessionID: "s1", prompt: { text }, delivery: "steer" }),
  }
}

async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${label}`)
}

// Wire-format messages, shaped like SessionContextHook.messages and SessionMessageInfo.
const userMessage = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
const assistantMessage = (text: string, extra: Record<string, any> = {}) => ({
  type: "assistant",
  content: [{ type: "text", text }],
  ...extra,
})
const contextEvent = (system: Array<{ type: string; text: string }>, messages: Array<Record<string, any>>) => ({
  sessionID: "s1",
  // No `kind` field: the server does not put one on context hook events.
  agent: "build",
  model: {},
  system,
  messages,
  options: {},
  tools: {},
})

test("isGoalState accepts valid goals and rejects malformed state", () => {
  assert.equal(isGoalState({ objective: "ship it", status: "active", continuations: 0 }), true)
  assert.equal(isGoalState({ objective: "  ", status: "active", continuations: 0 }), false)
  assert.equal(isGoalState({ objective: "ship it", status: "sideways", continuations: 0 }), false)
  assert.equal(isGoalState({ objective: "ship it", status: "active", continuations: -1 }), false)
  assert.equal(isGoalState({ objective: "ship it", status: "active", continuations: 1.5 }), false)
  assert.equal(isGoalState(null), false)
})

test("parseGoalCommand separates reserved words from objectives", () => {
  assert.deepEqual(parseGoalCommand("/goal status"), { action: "status" })
  assert.deepEqual(parseGoalCommand("/goal pause"), { action: "pause" })
  assert.deepEqual(parseGoalCommand("/goal resume refactor"), { action: "resume" })
  assert.deepEqual(parseGoalCommand("/goal clear"), { action: "clear" })
  assert.deepEqual(parseGoalCommand("/goal set status page"), { action: "start", objective: "status page" })
  assert.deepEqual(parseGoalCommand("/goal Fix the failing tests"), {
    action: "start",
    objective: "Fix the failing tests",
  })
  assert.deepEqual(parseGoalCommand("/goal"), { action: "none" })
  assert.deepEqual(parseGoalCommand("/goal set"), { action: "none" })
})

test("context hook injects the standing goal into model requests", async (t) => {
  const h = makeHarness()
  const cleanup = await plugin.setup(h.ctx)
  t.after(() => cleanup?.())

  await h.run("/goal Ship the plugin")
  const system: Array<{ type: string; text: string }> = []
  await h.contextHook()!(contextEvent(system, [userMessage("Ship the plugin")]))

  assert.ok(system.some((part) => part.text.includes("standing goal") && part.text.includes("Ship the plugin")))
})

test("an earlier /goal status request does not turn later requests into status reports", async (t) => {
  const h = makeHarness()
  const cleanup = await plugin.setup(h.ctx)
  t.after(() => cleanup?.())

  await h.run("/goal Ship the plugin")
  const system: Array<{ type: string; text: string }> = []
  await h.contextHook()!(
    contextEvent(system, [
      userMessage(`${MARKER}\nSaved goal status: active\nReport this only; do not work on the project.`),
      assistantMessage("Saved goal status: active"),
      userMessage("Now do the actual work"),
    ]),
  )

  assert.ok(system.some((part) => part.text.includes("standing goal")))
  assert.ok(!system.some((part) => part.text.includes("only asks for persistent goal status")))
})

test("a completed turn queues one continuation and the completion marker ends the goal", async (t) => {
  const h = makeHarness()
  const cleanup = await plugin.setup(h.ctx)
  t.after(() => cleanup?.())

  await h.run("/goal Ship the plugin")
  h.setMessages([userMessage("keep going"), assistantMessage("Still working on it.")])
  // The server signals end-of-turn with execution.succeeded; session.idle is never emitted.
  h.push({ type: "session.execution.succeeded", data: { sessionID: "s1" } })

  await until(() => h.prompts.length === 2, "a continuation prompt")
  assert.equal(h.prompts[1].delivery, "queue")
  assert.match(String(h.prompts[1].text), /Continue the saved goal/)

  h.setMessages([userMessage("keep going"), assistantMessage("All done.\n<goal-complete>")])
  h.push({ type: "session.execution.succeeded", data: { sessionID: "s1" } })

  await until(() => h.goal()?.status === "complete", "goal completion")
  assert.equal(h.prompts.length, 2)
})

test("a provider error pauses the goal instead of continuing", async (t) => {
  const h = makeHarness()
  const cleanup = await plugin.setup(h.ctx)
  t.after(() => cleanup?.())

  await h.run("/goal Ship the plugin")
  h.setMessages([userMessage("keep going"), assistantMessage("", { error: { type: "provider", message: "boom" } })])
  h.push({ type: "session.execution.succeeded", data: { sessionID: "s1" } })

  await until(() => h.goal()?.status === "paused", "goal pause on error")
  assert.equal(h.prompts.length, 1)
})

test("the continuation cap pauses the goal and posts a visible notice", async (t) => {
  const h = makeHarness()
  ;(h.ctx as any).options = { maxContinuations: 1 }
  const cleanup = await plugin.setup(h.ctx)
  t.after(() => cleanup?.())

  await h.run("/goal Ship the plugin")
  h.setMessages([userMessage("keep going"), assistantMessage("Still working on it.")])
  h.push({ type: "session.execution.succeeded", data: { sessionID: "s1" } })
  await until(() => h.prompts.length === 2, "the first continuation")
  h.push({ type: "session.execution.succeeded", data: { sessionID: "s1" } })

  await until(() => h.goal()?.status === "limit", "goal limit")
  assert.equal(h.prompts.length, 2)
  assert.equal(h.synthetics.length, 1)
  assert.match(String(h.synthetics[0].text), /cap of 1 auto-continuations/)
})

test("only the instance for the session's own location continues", async (t) => {
  const h = makeHarness()
  const cleanup = await plugin.setup(h.ctx)
  t.after(() => cleanup?.())

  await h.run("/goal Ship the plugin")
  h.setSessionLocation("/somewhere/else")
  h.setMessages([userMessage("keep going"), assistantMessage("Still working on it.")])
  h.push({ type: "session.execution.succeeded", data: { sessionID: "s1" } })

  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(h.prompts.length, 1)
})
