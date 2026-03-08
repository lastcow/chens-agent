/**
 * Canvas API client — thin wrapper around the Canvas REST API.
 * All agent Canvas tools must go through this client.
 */

const BASE = process.env.CANVAS_BASE_URL!; // https://frostburg.instructure.com/api/v1

// Per-task token override (set before each task execution)
let _activeToken: string | null = null;
export function setActiveToken(token: string | null) { _activeToken = token; }
function getToken() { return _activeToken ?? process.env.CANVAS_TOKEN ?? ""; }

export interface CanvasRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: Record<string, unknown>;
  dryRun?: boolean;
}

let callCount = 0;
const RATE_LIMIT = 100; // max per minute
const callWindow: number[] = [];

function checkRateLimit() {
  const now = Date.now();
  const windowStart = now - 60_000;
  while (callWindow.length && callWindow[0] < windowStart) callWindow.shift();
  if (callWindow.length >= RATE_LIMIT) {
    throw new Error(`Canvas API rate limit reached (${RATE_LIMIT} req/min)`);
  }
  callWindow.push(now);
  callCount++;
}

export async function canvasRequest<T = unknown>(
  path: string,
  options: CanvasRequestOptions = {}
): Promise<T> {
  const { method = "GET", body, dryRun = false } = options;

  // Block writes in dry-run mode
  if (dryRun && method !== "GET") {
    console.log(`[DRY-RUN] Would ${method} ${path}`, body);
    return { dryRun: true, path, body } as T;
  }

  checkRateLimit();

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Canvas API ${method} ${path} → ${res.status}: ${err}`);
  }

  return res.json() as T;
}

export function getCallCount() { return callCount; }
export function resetCallCount() { callCount = 0; }
