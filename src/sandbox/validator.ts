/**
 * Static code validator — run BEFORE sandbox execution.
 * Catches dangerous patterns in agent-generated tool code.
 */

interface ValidationResult {
  safe: boolean;
  violations: string[];
}

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\beval\s*\(/,              reason: "eval() is not allowed" },
  { pattern: /new\s+Function\s*\(/,      reason: "new Function() is not allowed" },
  { pattern: /child_process/,            reason: "child_process module is not allowed" },
  { pattern: /\bexec\s*\(/,             reason: "exec() is not allowed" },
  { pattern: /\bspawn\s*\(/,            reason: "spawn() is not allowed" },
  { pattern: /require\s*\(/,            reason: "require() is not allowed — use provided imports only" },
  { pattern: /import\s+.*from\s+['"](?!\.)/,  reason: "External imports not allowed — use provided canvasRequest" },
  { pattern: /process\.env/,            reason: "process.env access not allowed in tools" },
  { pattern: /process\.exit/,           reason: "process.exit() not allowed" },
  { pattern: /\bfs\b/,                  reason: "File system access not allowed" },
  { pattern: /XMLHttpRequest/,          reason: "XMLHttpRequest not allowed — use canvasRequest" },
  { pattern: /fetch\s*\(/,             reason: "Direct fetch() not allowed — use canvasRequest" },
  { pattern: /while\s*\(\s*true\s*\)/, reason: "Infinite while(true) loop detected" },
  { pattern: /for\s*\(\s*;\s*;\s*\)/,  reason: "Infinite for(;;) loop detected" },
  { pattern: /\.env\b/,                reason: ".env access not allowed" },
  { pattern: /Buffer\s*\.\s*from/,     reason: "Buffer operations restricted in tools" },
  { pattern: /\/__proto__/,            reason: "Prototype pollution attempt detected" },
  { pattern: /constructor\s*\[/,       reason: "Constructor access attempt detected" },
];

const REQUIRED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /canvasRequest/, reason: "Tool must use canvasRequest for all Canvas API calls" },
];

export function validateToolCode(code: string): ValidationResult {
  const violations: string[] = [];

  // Check blocked patterns
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(code)) {
      violations.push(`🚫 ${reason}`);
    }
  }

  // Check required patterns (only for Canvas tools)
  if (code.includes("canvas") || code.includes("Canvas")) {
    for (const { pattern, reason } of REQUIRED_PATTERNS) {
      if (!pattern.test(code)) {
        violations.push(`⚠️ ${reason}`);
      }
    }
  }

  // Check code length (sanity check)
  if (code.length > 10_000) {
    violations.push("⚠️ Tool code exceeds 10KB limit");
  }

  return { safe: violations.length === 0, violations };
}

export function validateToolSchema(schema: unknown): ValidationResult {
  const violations: string[] = [];

  if (typeof schema !== "object" || schema === null) {
    violations.push("Schema must be an object");
    return { safe: false, violations };
  }

  const s = schema as Record<string, unknown>;
  if (!s.input || typeof s.input !== "object") violations.push("Schema must have 'input' object");
  if (!s.output || typeof s.output !== "object") violations.push("Schema must have 'output' object");

  return { safe: violations.length === 0, violations };
}
