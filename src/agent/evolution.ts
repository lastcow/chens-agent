/**
 * Self-Evolution Engine — the agent designs, validates, and registers new tools.
 */

import Anthropic from "@anthropic-ai/sdk";
import { ToolTier } from "@prisma/client";
import { deduplicateTool, registerTool, type ToolDefinition } from "../tools/registry.js";
import { runInSandbox } from "../sandbox/runner.js";
import { db } from "../db/client.js";

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const EVOLUTION_SYSTEM = `You are a tool engineer for a Canvas LMS AI agent.
When given a task that requires a missing capability, you design a new TypeScript tool.

Rules for tool code:
- ONLY use the provided "canvasRequest" function for Canvas API calls
- canvasRequest(path, {method?, body?}) returns JSON
- NO eval, exec, require, fetch, fs, process.env
- Must complete in under 10 seconds
- Must be a single async function body (no imports, no class declarations)
- Return an object matching the output schema

Canvas API base: already set. Just use paths like "/courses", "/courses/:id/assignments", etc.`;

export interface EvolutionResult {
  action: "USED_EXISTING" | "EXTENDED" | "CREATED" | "FAILED";
  toolName?: string;
  toolId?: string;
  reason?: string;
  sandboxResult?: Record<string, unknown>;
  attempts: number;
}

export async function evolveNewTool(
  missingCapability: string,
  taskContext: string
): Promise<EvolutionResult> {
  let attempts = 0;
  const MAX_ATTEMPTS = 3;

  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    console.log(`[EVOLUTION] Attempt ${attempts}/${MAX_ATTEMPTS} for: ${missingCapability}`);

    // Step 1: Ask Claude to design the tool
    const design = await claude.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 2000,
      system: EVOLUTION_SYSTEM,
      messages: [{
        role: "user",
        content: `Task context: ${taskContext}
Missing capability: ${missingCapability}

Design a new Canvas LMS tool. Respond ONLY with valid JSON:
{
  "name": "snake_case_tool_name",
  "description": "clear one-sentence description",
  "tier": "GREEN|YELLOW|RED",
  "schema": {
    "input": { "param_name": { "type": "string|number|boolean", "description": "..." } },
    "output": { "result_field": { "type": "string|number|boolean", "description": "..." } }
  },
  "code": "// async function body using canvasRequest\\nconst result = await canvasRequest('/path');\\nreturn result;",
  "tests": [
    { "input": { "param": "test_value" }, "expectedOutput": { "result_field": "anything" } }
  ],
  "evolutionReason": "why this tool is needed"
}`
      }],
    });

    let def: ToolDefinition;
    try {
      const text = design.content[0].type === "text" ? design.content[0].text : "";
      const json = text.match(/\{[\s\S]*\}/)?.[0];
      if (!json) throw new Error("No JSON in response");
      const parsed = JSON.parse(json);
      def = { ...parsed, tier: parsed.tier as ToolTier, createdBy: "agent" };
    } catch (err) {
      console.error(`[EVOLUTION] Failed to parse tool design:`, err);
      continue;
    }

    // Step 2: Deduplication check
    const dedup = await deduplicateTool(def);

    if (dedup.action === "USE_EXISTING") {
      return {
        action: "USED_EXISTING",
        toolName: dedup.matchedTool!.name,
        toolId: dedup.matchedTool!.id,
        reason: dedup.reason,
        attempts,
      };
    }

    if (dedup.action === "EXTEND_EXISTING") {
      // Ask Claude to extend the existing tool
      console.log(`[EVOLUTION] Near-duplicate found: "${dedup.matchedTool!.name}" (${dedup.similarity?.toFixed(3)}). Extending...`);
      def.name = dedup.matchedTool!.name; // keep same name → version bump
      def.evolutionReason = `Extended from v${dedup.matchedTool!.version}: ${missingCapability}`;
    }

    // Step 3: Sandbox
    const sandboxResult = await runInSandbox(def);

    if (!sandboxResult.passed) {
      console.warn(`[EVOLUTION] Sandbox failed (attempt ${attempts}):`, sandboxResult.failures, sandboxResult.violations);

      if (attempts < MAX_ATTEMPTS) {
        // Ask Claude to fix
        await claude.messages.create({
          model: "claude-sonnet-4-5",
          max_tokens: 500,
          messages: [{
            role: "user",
            content: `Fix this tool. Failures: ${JSON.stringify(sandboxResult.failures)}. Violations: ${sandboxResult.violations.join(", ")}. Original code: ${def.code}`,
          }],
        });
        continue;
      }

      // Quarantine after max attempts
      await db.auditLog.create({
        data: {
          actor: "agent",
          action: "TOOL_QUARANTINED",
          details: { name: def.name, sandboxResult: sandboxResult as unknown as object, attempts } as object,
        },
      });

      return { action: "FAILED", reason: "Sandbox failed after max attempts", sandboxResult: sandboxResult as unknown as Record<string, unknown> | undefined, attempts };
    }

    // Step 4: Register
    const variantOfId = dedup.action === "REGISTER_NEW" && dedup.matchedTool
      ? dedup.matchedTool.id
      : undefined;

    const tool = await registerTool(def, true, variantOfId);

    console.log(`[EVOLUTION] ✅ Tool registered: ${tool.name} v${tool.version} (${tool.tier}) status=${tool.status}`);

    return {
      action: dedup.action === "EXTEND_EXISTING" ? "EXTENDED" : "CREATED",
      toolName: tool.name,
      toolId: tool.id,
      sandboxResult: sandboxResult as unknown as Record<string, unknown>,
      attempts,
    };
  }

  return { action: "FAILED", reason: "Max evolution attempts exceeded", attempts };
}
