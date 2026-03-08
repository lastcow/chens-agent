/**
 * HTTP API server for ChensAgent.
 * Exposes task submission, status, and tool registry endpoints.
 */

import express from "express";
import { Redis } from "@upstash/redis";
import { db } from "../db/client.js";
import { getApprovedTools } from "../tools/registry.js";
import { seedCoreTools } from "../tools/seed.js";
import { TaskStatus } from "@prisma/client";

const app = express();
app.use(express.json());

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const QUEUE_KEY = "chens:agent:tasks";

// ─── Auth middleware ──────────────────────────────────────────────
function requireApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key = req.headers["x-api-key"];
  if (key !== process.env.AGENT_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

app.use(requireApiKey);

// ─── Health ───────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "ChensAgent", version: "1.0.0", timestamp: new Date().toISOString() });
});

// ─── Submit task ─────────────────────────────────────────────────
app.post("/tasks", async (req, res) => {
  const { instruction, courseId, createdBy = "teacher", canvasToken } = req.body;
  if (!instruction) { res.status(400).json({ error: "instruction is required" }); return; }

  const task = await db.agentTask.create({
    data: { title: instruction.slice(0, 80), instruction, courseId, createdBy, status: TaskStatus.QUEUED },
  });

  await redis.lpush(QUEUE_KEY, JSON.stringify({ taskId: task.id, canvasToken }));

  res.status(202).json({ taskId: task.id, status: "QUEUED" });
});

// ─── Get task status ─────────────────────────────────────────────
app.get("/tasks/:id", async (req, res) => {
  const task = await db.agentTask.findUnique({ where: { id: req.params.id } });
  if (!task) { res.status(404).json({ error: "Task not found" }); return; }
  res.json(task);
});

// ─── List tasks ───────────────────────────────────────────────────
app.get("/tasks", async (_req, res) => {
  const tasks = await db.agentTask.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, title: true, status: true, createdAt: true, completedAt: true, toolsUsed: true },
  });
  res.json({ tasks });
});

// ─── Cancel task ──────────────────────────────────────────────────
app.delete("/tasks/:id", async (req, res) => {
  await db.agentTask.update({
    where: { id: req.params.id },
    data: { status: TaskStatus.CANCELLED },
  });
  res.json({ message: "Task cancelled" });
});

// ─── List tools ───────────────────────────────────────────────────
app.get("/tools", async (_req, res) => {
  const tools = await getApprovedTools();
  res.json({ tools: tools.map(t => ({
    id: t.id, name: t.name, version: t.version,
    description: t.description, tier: t.tier,
    usageCount: t.usageCount, createdBy: t.createdBy,
    evolutionReason: t.evolutionReason,
  }))});
});

// ─── Approve RED tier tool ────────────────────────────────────────
app.post("/tools/:id/approve", async (req, res) => {
  const role = req.headers["x-user-role"];
  if (role !== "ADMIN") { res.status(403).json({ error: "Admin only" }); return; }

  const tool = await db.tool.update({
    where: { id: req.params.id },
    data: { status: "APPROVED", approvedBy: "dr_chen", approvedAt: new Date() },
  });
  res.json(tool);
});

// ─── Force re-seed a specific tool (updates code from seed definitions) ──────
app.post("/tools/:name/reseed", async (req, res) => {
  const { seedCoreTools } = await import("../tools/seed.js");
  try {
    await seedCoreTools(true); // force=true bypasses "already exists" skip
    res.json({ success: true, message: "Core tools reseeded with latest definitions" });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Dedup events ─────────────────────────────────────────────────
app.get("/tools/dedup-log", async (_req, res) => {
  const events = await db.dedupEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json({ events });
});

// ─── Audit log ────────────────────────────────────────────────────
app.get("/audit", async (_req, res) => {
  const logs = await db.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json({ logs });
});

// ─── SSE: task status stream ─────────────────────────────────────
app.get("/tasks/:id/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // Poll DB every 2s for task updates
  const interval = setInterval(async () => {
    const task = await db.agentTask.findUnique({
      where: { id: req.params.id },
      select: { status: true, result: true, error: true, steps: true },
    });
    if (task) {
      send(task);
      if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
        clearInterval(interval);
        res.end();
      }
    }
  }, 2000);

  req.on("close", () => clearInterval(interval));
});

export async function startServer(): Promise<void> {
  await seedCoreTools();
  const port = process.env.PORT ?? 8080;
  app.listen(port, () => console.log(`[API] ChensAgent API listening on :${port}`));
}
