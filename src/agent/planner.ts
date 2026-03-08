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

interface ReActStep {
  step: number;
  thought: string;
  action?: { tool: string; input: Record<string, unknown> };
  observation?: unknown;
  evolved?: boolean;
}

export async function runAgentTask(taskId: string): Promise<void> {
  const task = await db.agentTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error(`Task ${taskId} not found`);

  await db.agentTask.update({
    where: { id: taskId },
    data: { status: TaskStatus.RUNNING, startedAt: new Date() },
  });

  const steps: ReActStep[] = [];
  const toolsUsed: string[] = [];
  let stepNum = 0;

  try {
    // Build system prompt with available tools
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
        model: "claude-sonnet-4-5",
        max_tokens: 1500,
        messages,
      });

      const text = response.content[0].type === "text" ? response.content[0].text : "";
      console.log(`[AGENT] Step ${stepNum}:\n${text}`);

      // Parse NEED_TOOL request
      const needTool = text.match(/NEED_TOOL:\s*(.+)/);
      if (needTool) {
        const capability = needTool[1].trim();
        console.log(`[AGENT] Requesting new tool: ${capability}`);

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

        try { input = JSON.parse(inputStr); } catch { /* ignore parse errors */ }

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

        await db.agentTask.update({
          where: { id: taskId },
          data: {
            status: TaskStatus.COMPLETED,
            result: { answer, steps } as unknown as object,
            steps: steps as unknown as object[],
            toolsUsed,
            completedAt: new Date(),
          },
        });

        await db.auditLog.create({
          data: {
            actor: "agent",
            action: "TASK_COMPLETED",
            target: taskId,
            details: { toolsUsed, stepCount: stepNum } as object,
          },
        });

        return;
      }

      // No action found — add thought and continue
      steps.push({ step: stepNum, thought: text });
      messages.push({ role: "assistant", content: text });
      messages.push({ role: "user", content: "Continue." });
    }

    throw new Error("Max steps reached without Final Answer");
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await db.agentTask.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.FAILED,
        error: errorMsg,
        steps: steps as unknown as object[],
        toolsUsed,
        completedAt: new Date(),
      },
    });
    throw err;
  }
}
