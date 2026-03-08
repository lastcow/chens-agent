import { db } from "../db/client.js";
import { Tool, ToolStatus, ToolTier } from "@prisma/client";
import { embedText } from "../agent/embedder.js";
import { z } from "zod";

const DEDUP_EXACT = 0.95;
const DEDUP_NEAR  = 0.80;

export interface ToolDefinition {
  name: string;
  description: string;
  schema: { input: Record<string, unknown>; output: Record<string, unknown> };
  code: string;
  tests: Array<{ input: Record<string, unknown>; expectedOutput: Record<string, unknown> }>;
  tier: ToolTier;
  evolutionReason?: string;
  createdBy?: string;
}

// ─── Build embedding text for a tool ─────────────────────────────
function buildEmbedText(def: Pick<ToolDefinition, "name" | "description" | "schema">): string {
  return [
    `Tool: ${def.name}`,
    `Description: ${def.description}`,
    `Inputs: ${JSON.stringify(def.schema.input)}`,
    `Outputs: ${JSON.stringify(def.schema.output)}`,
  ].join("\n");
}

// ─── Deduplication check ─────────────────────────────────────────
export async function deduplicateTool(def: ToolDefinition): Promise<{
  action: "USE_EXISTING" | "EXTEND_EXISTING" | "REGISTER_NEW";
  matchedTool?: Tool;
  similarity?: number;
  reason?: string;
}> {
  const embedText_ = buildEmbedText(def);
  const embedding = await embedText(embedText_);
  const vectorStr = `[${embedding.join(",")}]`;

  // Raw pgvector similarity search
  const results = await db.$queryRawUnsafe<Array<{ id: string; name: string; similarity: number }>>(
    `SELECT id, name, 1 - (embedding <=> $1::vector) AS similarity
     FROM "Tool"
     WHERE status = 'APPROVED'
     ORDER BY embedding <=> $1::vector
     LIMIT 5`,
    vectorStr
  );

  if (!results.length) return { action: "REGISTER_NEW" };

  const top = results[0];

  // Log dedup event
  await db.dedupEvent.create({
    data: {
      proposedName: def.name,
      proposedDesc: def.description,
      matchedId: top.similarity > DEDUP_NEAR ? top.id : undefined,
      similarity: top.similarity,
      action: top.similarity >= DEDUP_EXACT ? "BLOCKED"
             : top.similarity >= DEDUP_NEAR ? "EXTEND_EXISTING"
             : "REGISTER_NEW",
    },
  });

  if (top.similarity >= DEDUP_EXACT) {
    const matchedTool = await db.tool.findUnique({ where: { id: top.id } });
    await db.tool.update({ where: { id: top.id }, data: { dedupBlocked: { increment: 1 } } });
    return {
      action: "USE_EXISTING",
      matchedTool: matchedTool!,
      similarity: top.similarity,
      reason: `Exact duplicate of "${top.name}" (similarity: ${top.similarity.toFixed(3)})`,
    };
  }

  if (top.similarity >= DEDUP_NEAR) {
    const matchedTool = await db.tool.findUnique({ where: { id: top.id } });
    return {
      action: "EXTEND_EXISTING",
      matchedTool: matchedTool!,
      similarity: top.similarity,
      reason: `Near-duplicate of "${top.name}" (similarity: ${top.similarity.toFixed(3)}). Consider extending.`,
    };
  }

  return { action: "REGISTER_NEW", similarity: top.similarity };
}

// ─── Register a new tool ─────────────────────────────────────────
export async function registerTool(
  def: ToolDefinition,
  sandboxPassed: boolean,
  variantOfId?: string
): Promise<Tool> {
  const embedText_ = buildEmbedText(def);
  const embedding = await embedText(embedText_);
  const vectorStr = `[${embedding.join(",")}]`;

  // Determine initial status
  const status: ToolStatus =
    def.tier === ToolTier.RED ? ToolStatus.PENDING_APPROVAL :
    sandboxPassed             ? ToolStatus.APPROVED :
                                ToolStatus.SANDBOX_FAILED;

  // Upsert (handles version bumps)
  const existing = await db.tool.findUnique({ where: { name: def.name } });
  let tool: Tool;

  if (existing) {
    tool = await db.tool.update({
      where: { name: def.name },
      data: {
        version:        { increment: 1 },
        description:    def.description,
        schema:         def.schema as unknown as object,
        code:           def.code,
        tests:          def.tests as unknown as object[],
        tier:           def.tier,
        status,
        sandboxPassedAt: sandboxPassed ? new Date() : undefined,
        embeddingText:  embedText_,
        evolutionReason: def.evolutionReason,
      },
    });
  } else {
    tool = await db.tool.create({
      data: {
        name:           def.name,
        description:    def.description,
        schema:         def.schema as unknown as object,
        code:           def.code,
        tests:          def.tests as unknown as object[],
        tier:           def.tier,
        status,
        createdBy:      def.createdBy ?? "agent",
        sandboxPassedAt: sandboxPassed ? new Date() : undefined,
        embeddingText:  embedText_,
        evolutionReason: def.evolutionReason,
        variantOfId,
      },
    });
  }

  // Store embedding vector via raw SQL
  await db.$executeRawUnsafe(
    `UPDATE "Tool" SET embedding = $1::vector WHERE id = $2`,
    vectorStr,
    tool.id
  );

  await db.auditLog.create({
    data: {
      actor: def.createdBy ?? "agent",
      action: existing ? "TOOL_VERSION_BUMP" : "TOOL_REGISTERED",
      target: tool.id,
      details: { name: def.name, tier: def.tier, status, sandboxPassed },
    },
  });

  return tool;
}

// ─── Get approved tools for agent planning ───────────────────────
export async function getApprovedTools(): Promise<Tool[]> {
  return db.tool.findMany({
    where: { status: ToolStatus.APPROVED },
    orderBy: { usageCount: "desc" },
  });
}

// ─── Execute a tool by name ───────────────────────────────────────
export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  taskId?: string,
  options?: { canvasToken?: string }
): Promise<unknown> {
  const tool = await db.tool.findUnique({ where: { name: toolName } });
  if (!tool || tool.status !== ToolStatus.APPROVED) {
    throw new Error(`Tool "${toolName}" not found or not approved`);
  }

  const start = Date.now();
  let output: unknown;
  let success = false;

  try {
    // Dynamically evaluate tool code in a controlled scope
    const fn = new Function(
      "input", "canvasRequest", "require",
      `const __fn = async (input) => { ${tool.code}\n}; return __fn(input);`
    );

    const { canvasRequest, setActiveToken } = await import("../canvas/client.js");
    if (options?.canvasToken) setActiveToken(options.canvasToken);
    output = await fn(input, canvasRequest, () => { throw new Error("require() not allowed in tools"); });
    success = true;
  } catch (err) {
    output = { error: err instanceof Error ? err.message : String(err) };
  }

  const duration = Date.now() - start;

  await db.toolExecution.create({
    data: { toolId: tool.id, taskId, input: input as unknown as object, output: output as unknown as object, durationMs: duration, success },
  });

  await db.tool.update({
    where: { id: tool.id },
    data: { usageCount: { increment: 1 }, lastUsedAt: new Date() },
  });

  if (!success) throw new Error((output as { error: string }).error);
  return output;
}
