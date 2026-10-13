import { Plugin } from "@opencode/plugin"

type GoalStatus = "active" | "paused" | "complete" | "blocked" | "limit"
type GoalState = { objective: string; status: GoalStatus; continuations: number }

const MAX_CONTINUATIONS = 12
const STATUS_ONLY_MARKER = "[[GOAL_STATUS_ONLY]]"
const COMPLETE_MARKER = "<goal-complete>"
const BLOCKED_MARKER = "<goal-blocked>"
const keyFor = (sessionID: string) => "goal/" + sessionID

export function isGoalState(value: unknown): value is GoalState {
  if (!value || typeof value !== "object") return false
  const goal = value as Partial<GoalState>
  return (
    typeof goal.objective === "string" &&
    goal.objective.trim().length > 0 &&
    ["active", "paused", "complete", "blocked", "limit"].includes(goal.status ?? "") &&
    Number.isSafeInteger(goal.continuations) &&
    (goal.continuations ?? -1) >= 0
  )
}

export type GoalCommand =
  | { action: "status" | "pause" | "resume" | "clear" }
  | { action: "start"; objective: string }
  | { action: "none" }

export function parseGoalCommand(input: string): GoalCommand {
  const args = input.trim().replace(/^\/goal(?:\s+|$)/i, "")
  const [first = "", ...rest] = args.split(/\s+/)
  const action = first.toLowerCase()
  if (action === "status" || action === "pause" || action === "resume" || action === "clear") return { action }
  const objective = (action === "set" ? rest.join(" ") : args).trim()
  return objective ? { action: "start", objective } : { action: "none" }
}

export default Plugin.define({
  id: "goal-mode",
  async setup(ctx) {
    const inFlight = new Set<string>()
    const getGoal = async (sessionID: string) => {
      const value = await ctx.storage.get(keyFor(sessionID))
      return isGoalState(value) ? value : undefined
    }
    const saveGoal = (sessionID: string, goal: GoalState) => ctx.storage.set(keyFor(sessionID), goal)
    const ask = <T extends { text: string }>(
      sessionID: string,
      prompt: T,
      text: string,
      delivery: "steer" | "queue" = "steer",
    ) => ctx.session.prompt({ ...prompt, sessionID, text, delivery })

    await ctx.session.hook("context", async (event) => {
      const goal = await getGoal(event.sessionID)
      if (!goal) return

      // Only the newest user message decides whether this request is status-only; an older
      // status request stays in history and must not disable goal mode for later turns.
      const latestUser = [...event.messages].reverse().find((message) => message.role === "user")
      if (latestUser?.content.some((part) => part.type === "text" && part.text.includes(STATUS_ONLY_MARKER))) {
        event.system.push({
          type: "text",
          text: "This request only asks for persistent goal status. Report the supplied status and objective; do not use tools or work on the project.",
        })
        return
      }

      const instruction =
        goal.status === "active"
          ? "Keep this as the standing goal for this session. Continue across turns, treat later user messages as clarifications or steering, and verify the result. When truly complete, end your final response with exactly " +
            COMPLETE_MARKER +
            " on its own line. If genuinely blocked, explain why and end with exactly " +
            BLOCKED_MARKER +
            " on its own line."
          : "The saved goal is " +
            goal.status +
            ". Do not continue it unless the user explicitly resumes or sets a new goal."

      event.system.push({
        type: "text",
        text:
          "Persistent goal (" +
          goal.status +
          ", auto-continuations " +
          goal.continuations +
          "/" +
          MAX_CONTINUATIONS +
          "):\n" +
          goal.objective +
          "\n" +
          instruction,
      })
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "goal",
        description: "Set or control a persistent goal",
        execute: async ({ sessionID, prompt, delivery }) => {
          const command = parseGoalCommand(prompt.text)

          if (command.action === "start") {
            const goal: GoalState = { objective: command.objective, status: "active", continuations: 0 }
            await saveGoal(sessionID, goal)
            await ask(
              sessionID,
              prompt,
              "Start persistent goal mode. Work toward this objective and verify the result:\n" +
                command.objective +
                "\nWhen truly complete, end your final response with exactly " +
                COMPLETE_MARKER +
                " on its own line. If genuinely blocked, explain why and end with exactly " +
                BLOCKED_MARKER +
                " on its own line.",
              delivery,
            )
            return
          }

          const current = await getGoal(sessionID)

          if (command.action === "status") {
            const summary = current
              ? "Saved goal status: " +
                current.status +
                "; auto-continuations: " +
                current.continuations +
                "/" +
                MAX_CONTINUATIONS +
                "; objective: " +
                current.objective
              : "No goal is saved. Start one with /goal <objective>."
            await ask(sessionID, prompt, STATUS_ONLY_MARKER + "\n" + summary + "\nReport this only; do not work on the project.")
            return
          }

          if (command.action === "pause") {
            if (current) {
              current.status = "paused"
              await saveGoal(sessionID, current)
            }
            await ask(sessionID, prompt, current ? "The user paused the saved goal. Confirm it is paused; do not continue work." : "There is no saved goal to pause. Reply with that.")
            return
          }

          if (command.action === "resume") {
            if (!current) {
              await ask(sessionID, prompt, "There is no saved goal to resume. Ask the user to start one with /goal <objective>.")
              return
            }
            current.status = "active"
            current.continuations = 0
            await saveGoal(sessionID, current)
            await ask(sessionID, prompt, "Resume the saved goal and continue working toward it now:\n" + current.objective, delivery)
            return
          }

          if (command.action === "clear") {
            await ctx.storage.remove(keyFor(sessionID))
            await ask(sessionID, prompt, "The user cleared goal mode. Acknowledge that; do not continue the saved goal.")
            return
          }

          if (command.action === "none") {
            await ask(sessionID, prompt, "No goal was supplied. Explain: use /goal <objective>, /goal set <objective>, /goal status, /goal pause, /goal resume, or /goal clear.")
          }
        },
      })
    })

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          // The server signals the end of a turn with execution.succeeded; session.idle is in
          // the protocol types but is never emitted, so it cannot drive continuation.
          if (event.type !== "session.execution.succeeded") continue
          const sessionID = event.data.sessionID
          if (inFlight.has(sessionID)) continue
          inFlight.add(sessionID)
          try {
            // Every location loads its own plugin instance, all instances receive the server-wide
            // event stream, and goal storage is shared, so only the instance for the session's own
            // location may act or a continuation would be queued more than once.
            const session = await ctx.session.get({ sessionID })
            if (session.location.directory !== ctx.location.directory) continue

            const goal = await getGoal(sessionID)
            if (!goal || goal.status !== "active") continue

            const messages = await ctx.session.context({ sessionID })
            const latestUser = [...messages].reverse().find((message) => message.type === "user")
            if (latestUser && latestUser.text.includes(STATUS_ONLY_MARKER)) continue

            const latestAssistant = [...messages].reverse().find((message) => message.type === "assistant")
            if (!latestAssistant) continue
            if (latestAssistant.error) {
              goal.status = "paused"
              await saveGoal(sessionID, goal)
              continue
            }

            const answer = latestAssistant.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
              .trimEnd()
            if (answer.endsWith(COMPLETE_MARKER)) {
              goal.status = "complete"
              await saveGoal(sessionID, goal)
              continue
            }
            if (answer.endsWith(BLOCKED_MARKER)) {
              goal.status = "blocked"
              await saveGoal(sessionID, goal)
              continue
            }
            if (goal.continuations >= MAX_CONTINUATIONS) {
              goal.status = "limit"
              await saveGoal(sessionID, goal)
              continue
            }

            goal.continuations += 1
            await saveGoal(sessionID, goal)
            try {
              await ctx.session.prompt({
                sessionID,
                text: "Continue the saved goal. Review what is complete, identify the next concrete step, do the work, and verify it. Do not stop unless the goal is complete or genuinely blocked.",
                delivery: "queue",
              })
            } catch (error) {
              goal.status = "paused"
              await saveGoal(sessionID, goal)
              throw error
            }
          } catch (error) {
            console.error("[goal-mode] Could not continue goal for session " + sessionID, error)
          } finally {
            inFlight.delete(sessionID)
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("[goal-mode] Event stream stopped", error)
      }
    })()

    return () => controller.abort()
  },
})
