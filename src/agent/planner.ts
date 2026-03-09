/**
 * ReAct Agent Planner — Reason → Act → Observe → Repeat
 * Uses Claude to plan tool calls and execute Canvas LMS tasks.
 */

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import { getApprovedTools, executeTool } from "../tools/registry.js";
import { evolveNewTool } from "./evolution.js";
import { db } from "../db/client.js";
import { TaskStatus } from "@prisma/client";

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const nvidia = new OpenAI({
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKey: process.env.NVIDIA_API_KEY!,
});

function isGeminiModel(model: string) { return model.startsWith("gemini"); }
function isNvidiaModel(model: string)  { return NVIDIA_MODELS.has(model); }

// Curated NVIDIA NIM models available via integrate.api.nvidia.com
export const NVIDIA_MODELS = new Set([
  "meta/llama-3.3-70b-instruct",
  "meta/llama-3.1-405b-instruct",
  "nvidia/llama-3.1-nemotron-70b-instruct",
  "deepseek-ai/deepseek-r1-distill-qwen-32b",
  "deepseek-ai/deepseek-v3.2",
  "mistralai/mixtral-8x22b-instruct-v0.1",
  "google/gemma-3-27b-it",
]);

function msgText(m: Anthropic.MessageParam): string {
  return typeof m.content === "string" ? m.content : (m.content[0] as { text: string }).text;
}

async function callLLM(model: string, messages: Anthropic.MessageParam[], _systemPrompt: string): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  if (isGeminiModel(model)) {
    const gemModel = genai.getGenerativeModel({
      model,
      systemInstruction: { role: "user", parts: [{ text: "You are a helpful AI agent." }] },
    });
    const allMessages = messages.map(m => ({
      role: m.role === "assistant" ? "model" as const : "user" as const,
      parts: [{ text: msgText(m) }],
    }));
    const history = allMessages.slice(0, -1);
    const lastText = msgText(messages[messages.length - 1]);
    const chat = gemModel.startChat({ history });
    const result = await chat.sendMessage(lastText);
    const text = result.response.text();
    const meta = result.response.usageMetadata;
    return { text, inputTokens: meta?.promptTokenCount ?? 0, outputTokens: meta?.candidatesTokenCount ?? 0 };
  }

  if (isNvidiaModel(model)) {
    const oaiMessages = messages.map(m => ({
      role: m.role as "user" | "assistant",
      content: msgText(m),
    }));
    const resp = await nvidia.chat.completions.create({
      model,
      messages: oaiMessages,
      max_tokens: 1500,
    });
    const text = resp.choices[0]?.message?.content ?? "";
    return {
      text,
      inputTokens: resp.usage?.prompt_tokens ?? 0,
      outputTokens: resp.usage?.completion_tokens ?? 0,
    };
  }

  // Anthropic Claude (default)
  const response = await claude.messages.create({ model, max_tokens: 1500, messages });
  const text = response.content[0].type === "text" ? response.content[0].text : "";
  return { text, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
}

const MAX_STEPS = 15;

async function logRunToChensAPI(userId: string, model: string, usage: UsageSummary & { model: string; totalCostUsd: number }): Promise<void> {
  const apiUrl  = process.env.CHENS_API_URL;
  const apiKey  = process.env.CHENS_API_SECRET_KEY;
  if (!apiUrl || !apiKey) return;

  const provider = isNvidiaModel(model) ? "nvidia" : isGeminiModel(model) ? "google" : "anthropic";

  await fetch(`${apiUrl}/api/user/agent-runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key":   apiKey,
      "x-user-id":   userId,
    },
    body: JSON.stringify({
      model,
      provider,
      task_type:     "agent",
      input_tokens:  usage.claude.inputTokens,
      output_tokens: usage.claude.outputTokens,
      cost_usd:      usage.totalCostUsd,
      metadata: {
        fly_ms:      usage.flyio.durationMs,
        fly_cost:    usage.flyio.costUsd,
        llm_cost:    usage.claude.costUsd,
        calls:       usage.claude.calls,
      },
    }),
  });
}

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  // Anthropic
  "claude-haiku-4-5-20251001":  { inputPerMTok: 0.80,  outputPerMTok: 4.00  },
  "claude-sonnet-4-5-20250929": { inputPerMTok: 3.00,  outputPerMTok: 15.00 },
  "claude-sonnet-4-6":          { inputPerMTok: 3.00,  outputPerMTok: 15.00 },
  // Google
  "gemini-2.5-flash":           { inputPerMTok: 0.15,  outputPerMTok: 0.60  },
  // NVIDIA NIM
  "meta/llama-3.3-70b-instruct":               { inputPerMTok: 0.77,  outputPerMTok: 0.77  },
  "meta/llama-3.1-405b-instruct":              { inputPerMTok: 5.00,  outputPerMTok: 16.00 },
  "nvidia/llama-3.1-nemotron-70b-instruct":    { inputPerMTok: 0.35,  outputPerMTok: 0.40  },
  "deepseek-ai/deepseek-r1-distill-qwen-32b":  { inputPerMTok: 0.60,  outputPerMTok: 2.19  },
  "deepseek-ai/deepseek-v3.2":                 { inputPerMTok: 0.20,  outputPerMTok: 0.60  },
  "mistralai/mixtral-8x22b-instruct-v0.1":     { inputPerMTok: 0.60,  outputPerMTok: 0.60  },
  "google/gemma-3-27b-it":                     { inputPerMTok: 0.20,  outputPerMTok: 0.20  },
};

const FLYIO_PER_SECOND = 0.0000019; // shared-cpu-1x

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

export async function runAgentTask(taskId: string, canvasToken?: string, modelOverride?: string): Promise<void> {
  const task = await db.agentTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error(`Task ${taskId} not found`);

  const { setActiveToken } = await import("../canvas/client.js");
  setActiveToken(canvasToken ?? null);

  const model = modelOverride ?? DEFAULT_MODEL;
  const modelPricing = MODEL_PRICING[model] ?? MODEL_PRICING[DEFAULT_MODEL];
  const taskStartMs = Date.now();

  console.log(`[AGENT] Using model: ${model} ($${modelPricing.inputPerMTok}/M in, $${modelPricing.outputPerMTok}/M out)`);

  await db.agentTask.update({
    where: { id: taskId },
    data: { status: TaskStatus.RUNNING, startedAt: new Date() },
  });

  const steps: ReActStep[] = [];
  const toolsUsed: string[] = [];
  let stepNum = 0;

  // Usage accumulators
  const usage: UsageSummary & { model: string } = {
    model,
    claude: { inputTokens: 0, outputTokens: 0, calls: 0, costUsd: 0 },
    flyio: { durationMs: 0, costUsd: 0 },
    gemini: { embeddingCalls: 0, costUsd: 0 },
    totalCostUsd: 0,
  };

  const finalizeUsage = () => {
    const durationMs = Date.now() - taskStartMs;
    usage.flyio.durationMs = durationMs;
    usage.flyio.costUsd = parseFloat(((durationMs / 1000) * FLYIO_PER_SECOND).toFixed(8));
    usage.claude.costUsd = parseFloat((
      (usage.claude.inputTokens / 1_000_000) * modelPricing.inputPerMTok +
      (usage.claude.outputTokens / 1_000_000) * modelPricing.outputPerMTok
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
Final Answer: <complete answer with ALL data retrieved — include full lists, tables, names, scores, IDs. Never summarize or truncate. The professor needs the actual data, not a description of it.>

If you need a tool that doesn't exist, say:
NEED_TOOL: description of the capability needed`,
    }];

    while (stepNum < MAX_STEPS) {
      stepNum++;

      const { text, inputTokens, outputTokens } = await callLLM(model, messages, messages[0].content as string);

      // Track token usage
      usage.claude.calls++;
      usage.claude.inputTokens += inputTokens;
      usage.claude.outputTokens += outputTokens;

      console.log(`[AGENT] Step ${stepNum} (in:${inputTokens} out:${outputTokens}):\n${text}`);

      // Push live step to DB so UI can poll it
      await db.agentTask.update({
        where: { id: taskId },
        data: { steps: steps as unknown as object[] },
      });

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

      // Push step with action info to DB
      const actionMatch = text.match(/Action:\s*(\w+)\s*\((\{[\s\S]*?\})\)/);
      if (actionMatch) {
        const [, toolName, inputStr] = actionMatch;
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(inputStr); } catch { /* ignore */ }

        steps.push({ step: stepNum, thought: text, action: { tool: toolName, input } });

        // Push "calling tool" state to DB immediately
        await db.agentTask.update({
          where: { id: taskId },
          data: { steps: steps as unknown as object[] },
        });

        let observation: unknown;
        try {
          observation = await executeTool(toolName, input, taskId);
          if (!toolsUsed.includes(toolName)) toolsUsed.push(toolName);
        } catch (err) {
          observation = { error: err instanceof Error ? err.message : String(err) };
        }

        steps[steps.length - 1].observation = observation;

        // Push completed step (with observation) to DB
        await db.agentTask.update({
          where: { id: taskId },
          data: { steps: steps as unknown as object[] },
        });

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

        // Log run to ChensAPI for profile cost tracking
        await logRunToChensAPI(task.createdBy, model, usage).catch(e =>
          console.warn("[AGENT] Failed to log run to ChensAPI:", e)
        );

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
