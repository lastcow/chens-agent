/**
 * In-process task queue — no Redis polling.
 * Tasks are enqueued directly and processed concurrently (max 3 at once).
 */

import { runAgentTask } from "../agent/planner.js";
import { db } from "../db/client.js";
import { TaskStatus } from "@prisma/client";

const MAX_CONCURRENT = 3;
let activeCount = 0;

interface QueueItem {
  taskId: string;
  canvasToken?: string;
  model?: string;
}

const queue: QueueItem[] = [];

async function processNext(): Promise<void> {
  if (activeCount >= MAX_CONCURRENT || queue.length === 0) return;

  const item = queue.shift()!;
  activeCount++;

  console.log(`[WORKER] Processing task ${item.taskId} model=${item.model ?? "default"} (active: ${activeCount})`);

  try {
    await runAgentTask(item.taskId, item.canvasToken, item.model);
    console.log(`[WORKER] ✅ Task ${item.taskId} completed`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[WORKER] ❌ Task ${item.taskId} failed:`, errorMsg);
  } finally {
    activeCount--;
    processNext(); // pick up next item
  }
}

export function enqueueTask(taskId: string, canvasToken?: string, model?: string): void {
  queue.push({ taskId, canvasToken, model });
  console.log(`[WORKER] Queued task ${taskId} (queue length: ${queue.length})`);
  processNext();
}

export async function startWorker(): Promise<void> {
  console.log("[WORKER] 🚀 ChensAgent in-process worker started (no Redis polling)");

  // Recover any stuck RUNNING tasks on startup
  const stuckTasks = await db.agentTask.findMany({
    where: { status: TaskStatus.RUNNING },
  });
  for (const t of stuckTasks) {
    console.log(`[WORKER] Recovering stuck task: ${t.id}`);
    await db.agentTask.update({
      where: { id: t.id },
      data: { status: TaskStatus.QUEUED },
    });
    enqueueTask(t.id);
  }
}
