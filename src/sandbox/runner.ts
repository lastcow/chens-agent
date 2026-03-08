/**
 * Sandbox runner — executes agent-generated tool code safely.
 * Uses a mock Canvas API so no real data is touched during testing.
 */

import { validateToolCode, validateToolSchema } from "./validator.js";
import type { ToolDefinition } from "../tools/registry.js";

const SANDBOX_TIMEOUT_MS = 10_000;

// ─── Mock Canvas API for sandbox ─────────────────────────────────
const mockCanvasRequest = async (path: string, options: Record<string, unknown> = {}) => {
  console.log(`[SANDBOX] Canvas call: ${options.method ?? "GET"} ${path}`);
  return {
    id: "mock_id_123",
    name: "Mock Course",
    title: "Mock Assignment",
    grade: "A",
    score: 95,
    message: "mock response",
    data: [],
  };
};

export interface SandboxResult {
  passed: boolean;
  testsRun: number;
  testsPassed: number;
  failures: Array<{ test: number; expected: unknown; actual: unknown; error?: string }>;
  violations: string[];
  durationMs: number;
}

export async function runInSandbox(def: ToolDefinition): Promise<SandboxResult> {
  const start = Date.now();
  const failures: SandboxResult["failures"] = [];
  const violations: string[] = [];

  // 1. Static validation
  const codeCheck = validateToolCode(def.code);
  const schemaCheck = validateToolSchema(def.schema);

  if (!codeCheck.safe) violations.push(...codeCheck.violations);
  if (!schemaCheck.safe) violations.push(...schemaCheck.violations);

  if (violations.length > 0) {
    return { passed: false, testsRun: 0, testsPassed: 0, failures, violations, durationMs: Date.now() - start };
  }

  // 2. Run test cases with mock Canvas
  const tests = def.tests as Array<{ input: Record<string, unknown>; expectedOutput: Record<string, unknown> }>;
  let testsPassed = 0;

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i];
    try {
      // Wrap in timeout
      const result = await Promise.race([
        runToolCode(def.code, test.input, mockCanvasRequest),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Sandbox timeout exceeded (10s)")), SANDBOX_TIMEOUT_MS)
        ),
      ]);

      // Loose check: verify expected keys exist in output
      const allKeysPresent = Object.keys(test.expectedOutput).every(
        (k) => result !== null && typeof result === "object" && k in (result as object)
      );

      if (allKeysPresent) {
        testsPassed++;
      } else {
        failures.push({ test: i, expected: test.expectedOutput, actual: result });
      }
    } catch (err) {
      failures.push({
        test: i,
        expected: test.expectedOutput,
        actual: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const durationMs = Date.now() - start;
  const passed = violations.length === 0 && failures.length === 0;

  return { passed, testsRun: tests.length, testsPassed, failures, violations, durationMs };
}

async function runToolCode(
  code: string,
  input: Record<string, unknown>,
  canvasRequest: typeof mockCanvasRequest
): Promise<unknown> {
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    "input", "canvasRequest",
    `return (async () => { ${code} })();`
  );
  return fn(input, canvasRequest);
}
