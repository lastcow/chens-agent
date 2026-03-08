/**
 * ReAct Agent Planner — Reason → Act → Observe → Repeat
 * Uses Claude to plan tool calls and execute Canvas LMS tasks.
 */

import Anthropic from "@anthropic-ai/sdk";
import { getApprovedTools, executeTool } from "../tools/registry.js";
import { evolveNewTool } from "./evolution.js";
import { db } from "../db/client.js";
import { TaskStatus } from "@prisma/client";

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const MAX_STEPS = 15;

// Pricing (as of 2025) — update if changed
const PRICING = {
  claude: {
    model: "claude-sonnet-4-5",
    inputPerMTok: 3.00,   // $3.00 per 1M input tokens
    outputPerMTok: 15.00, // $15.00 per 1M output tokens
  },
  flyio: {
    perSecond: 0.0000019, // shared-cpu-1x @ ~$0.0000019/s
  },
  gemini: {
    embeddingPerMTok: 0.0, // free tier
  },
};

interface UsageSummary {
  claude: { inputTokens: number; outputTokens: number; calls: number; costUsd: number };
  flyio: { durationMs: number; costUsd: number };
  gemini: { embeddingCalls: number; costUsd: number };
  totalCostUsd: number;
}

interface ReActStep {
  step: number;
  thought: string;
  action?: { tool: string; input: Record<string, unknown> };
  observation?: unknown;
  evolved?: boolean;
}

export async function runAgentTask(taskId: string, canvasToken?: string): Promise<void> {
  const task = await db.agentTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error(`Task ${taskId} not found`);

  const { setActiveToken } = await import("../canvas/client.js");
  setActiveToken(canvasToken ?? null);

  const taskStartMs = Date.now();

  await db.agentTask.update({
    where: { id: taskId },
    data: { status: TaskStatus.RUNNING, startedAt: new Date() },
  });

  const steps: ReActStep[] = [];
  const toolsUsed: string[] = [];
  let stepNum = 0;

  // Usage accumulators
  const usage: UsageSummary = {
    claude: { inputTokens: 0, outputTokens: 0, calls: 0, costUsd: 0 },
    flyio: { durationMs: 0, costUsd: 0 },
    gemini: { embeddingCalls: 0, costUsd: 0 },
    totalCostUsd: 0,
  };

  const finalizeUsage = () => {
    const durationMs = Date.now() - taskStartMs;
    usage.flyio.durationMs = durationMs;
    usage.flyio.costUsd = parseFloat(((durationMs / 1000) * PRICING.flyio.perSecond).toFixed(8));
    usage.claude.costUsd = parseFloat((
      (usage.claude.inputTokens / 1_000_000) * PRICING.claude.inputPerMTok +
      (usage.claude.outputTokens / 1_000_000) * PRICING.claude.outputPerMTok
    ).toFixed(6));
    usage.totalCostUsd = parseFloat((usage.claude.costUsd + usage.flyio.costUsd + usage.gemini.costUsd).toFixed(6));
  };

  try {
    const approvedTools = await getApprovedTools();
    const toolDocs = approvedTools.map(t =>
      `- ${t.name}: ${t.description}\n  Input: ${JSON.stringify((t.schema as Record<string, unknown>).input)}`
    ).join("\n");

    const messages: Anthropic.MessageParam[] = [{
      role: "user",
      content: `You are a Canvas LMS agent helping a professor at Frostburg State University.

Available tools:
${toolDocs || "(no tools registered yet — you can request new ones)"}

Task: ${task.instruction}
${task.courseId ? `Course ID: ${task.courseId}` : ""}

Use ReAct format:
Thought: reasoning about what to do next
Action: tool_name({"param": "value"})
Observation: [result]
... repeat ...
Final Answer: summary of what was accomplished

If you need a tool that doesn't exist, say:
NEED_TOOL: description of the capability needed`,
    }];

    while (stepNum < MAX_STEPS) {
      stepNum++;

      const response = await claude.messages.create({
        model: PRICING.claude.model,
        max_tokens: 1500,
        messages,
      });

      // Track token usage
      usage.claude.calls++;
      usage.claude.inputTokens += response.usage.input_tokens;
      usage.claude.outputTokens += response.usage.output_tokens;

      const text = response.content[0].type === "text" ? response.content[0].text : "";
      console.log(`[AGENT] Step ${stepNum} (in:${response.usage.input_tokens} out:${response.usage.output_tokens}):\n${text}`);

      // Parse NEED_TOOL request
      const needTool = text.match(/NEED_TOOL:\s*(.+)/);
      if (needTool) {
        const capability = needTool[1].trim();
        console.log(`[AGENT] Requesting new tool: ${capability}`);
        usage.gemini.embeddingCalls++; // evolution uses embedding

        const evolution = await evolveNewTool(capability, task.instruction);

        steps.push({
          step: stepNum,
          thought: `Need new tool: ${capability}`,
          observation: evolution,
          evolved: true,
        });

        const obsMsg = evolution.action === "FAILED"
          ? `Tool evolution failed: ${evolution.reason}. Try to accomplish the task differently.`
          : `New tool "${evolution.toolName}" is now available (${evolution.action}). Continue with the task.`;

        messages.push({ role: "assistant", content: text });
        messages.push({ role: "user", content: `Tool evolution result: ${obsMsg}` });
        continue;
      }

      // Parse Action
      const actionMatch = text.match(/Action:\s*(\w+)\s*\((\{[\s\S]*?\})\)/);
      if (actionMatch) {
        const [, toolName, inputStr] = actionMatch;
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(inputStr); } catch { /* ignore */ }

        steps.push({ step: stepNum, thought: text, action: { tool: toolName, input } });

        let observation: unknown;
        try {
          observation = await executeTool(toolName, input, taskId);
          if (!toolsUsed.includes(toolName)) toolsUsed.push(toolName);
        } catch (err) {
          observation = { error: err instanceof Error ? err.message : String(err) };
        }

        steps[steps.length - 1].observation = observation;
        messages.push({ role: "assistant", content: text });
        messages.push({ role: "user", content: `Observation: ${JSON.stringify(observation)}` });
        continue;
      }

      // Parse Final Answer
      if (text.includes("Final Answer:")) {
        const answer = text.split("Final Answer:")[1]?.trim();
        finalizeUsage();

        await db.agentTask.update({
          where: { id: taskId },
          data: {
            status: TaskStatus.COMPLETED,
            result: { answer, steps } as unknown as object,
            steps: steps as unknown as object[],
            toolsUsed,
            completedAt: new Date(),
            usage: usage as unknown as object,
          },
        });

        await db.auditLog.create({
          data: {
            actor: "agent",
            action: "TASK_COMPLETED",
            target: taskId,
            details: { toolsUsed, stepCount: stepNum, usage } as object,
          },
        });

        console.log(`[AGENT] ✅ Done — Claude: ${usage.claude.inputTokens}in/${usage.claude.outputTokens}out ($${usage.claude.costUsd}) | Fly: ${usage.flyio.durationMs}ms ($${usage.flyio.costUsd}) | Total: $${usage.totalCostUsd}`);
        return;
      }

      steps.push({ step: stepNum, thought: text });
      messages.push({ role: "assistant", content: text });
      messages.push({ role: "user", content: "Continue." });
    }

    throw new Error("Max steps reached without Final Answer");
  } catch (err) {
    finalizeUsage();
    const errorMsg = err instanceof Error ? err.message : String(err);
    await db.agentTask.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.FAILED,
        error: errorMsg,
        steps: steps as unknown as object[],
        toolsUsed,
        completedAt: new Date(),
        usage: usage as unknown as object,
      },
    });
    throw err;
  } finally {
    setActiveToken(null);
  }
}
