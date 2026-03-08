/**
 * Queue worker — polls Upstash Redis for tasks and runs the agent.
 * Runs continuously on Fly.io.
 */

import { Redis } from "@upstash/redis";
import { runAgentTask } from "../agent/planner.js";
import { db } from "../db/client.js";
import { TaskStatus } from "@prisma/client";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const QUEUE_KEY = "chens:agent:tasks";
const DLQ_KEY  = "chens:agent:dlq";
const POLL_INTERVAL_MS = 2000;
const MAX_RETRIES = 3;

interface QueueMessage {
  taskId: string;
  retries?: number;
}

async function processTask(msg: QueueMessage): Promise<void> {
  const { taskId, retries = 0 } = msg;
  console.log(`[WORKER] Processing task ${taskId} (attempt ${retries + 1})`);

  try {
    await runAgentTask(taskId);

    // Notify via Redis pub/sub
    await redis.publish(`chens:task:${taskId}`, JSON.stringify({ status: "COMPLETED" }));
    console.log(`[WORKER] ✅ Task ${taskId} completed`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[WORKER] ❌ Task ${taskId} failed:`, errorMsg);

    if (retries < MAX_RETRIES) {
      // Re-queue with incremented retry count
      await redis.lpush(QUEUE_KEY, JSON.stringify({ taskId, retries: retries + 1 }));
      console.log(`[WORKER] Requeued task ${taskId} (attempt ${retries + 2})`);
    } else {
      // Dead letter queue
      await redis.lpush(DLQ_KEY, JSON.stringify({ taskId, error: errorMsg, retries }));
      await redis.publish(`chens:task:${taskId}`, JSON.stringify({ status: "FAILED", error: errorMsg }));
      console.error(`[WORKER] Task ${taskId} moved to DLQ after ${retries + 1} attempts`);
    }
  }
}

export async function startWorker(): Promise<void> {
  console.log("[WORKER] 🚀 ChensAgent worker started");
  console.log(`[WORKER] Polling queue: ${QUEUE_KEY} every ${POLL_INTERVAL_MS}ms`);

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
    await redis.lpush(QUEUE_KEY, JSON.stringify({ taskId: t.id }));
  }

  // Main poll loop
  while (true) {
    try {
      const result = await redis.rpop(QUEUE_KEY);

      if (result !== null) {
        const raw = typeof result === "string" ? result : JSON.stringify(result);
        const msg: QueueMessage = JSON.parse(raw);
        await processTask(msg);
      }
    } catch (err) {
      console.error("[WORKER] Poll error:", err);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}
