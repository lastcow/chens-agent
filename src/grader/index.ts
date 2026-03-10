/**
 * Grading orchestration — fetches submissions, calls OpenRouter LLM, returns structured preview
 */
import OpenAI from "openai";
import mammoth from "mammoth";
// @ts-ignore — pdf-parse ESM export issue
import pdfParse from "pdf-parse/node";
import { canvasRequest, setActiveToken } from "../canvas/client.js";

/** Download a Canvas attachment and extract plain text */
async function extractAttachmentText(url: string, filename: string, token: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return `[Could not download: ${filename}]`;

    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    const buf = Buffer.from(await res.arrayBuffer());

    if (ext === "docx" || ext === "doc") {
      const result = await mammoth.extractRawText({ buffer: buf });
      return result.value.slice(0, 8000).trim() || `[Empty DOCX: ${filename}]`;
    }
    if (ext === "pdf") {
      const result = await pdfParse(buf);
      return result.text.slice(0, 8000).trim() || `[Empty PDF: ${filename}]`;
    }
    if (["txt", "md", "py", "js", "ts", "java", "c", "cpp", "html", "css"].includes(ext)) {
      return buf.toString("utf8").slice(0, 8000).trim();
    }
    return `[Attachment: ${filename} (${ext.toUpperCase()} — not parsed)]`;
  } catch (err) {
    return `[Failed to parse ${filename}: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

const openrouter = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY!,
  defaultHeaders: { "HTTP-Referer": "https://chen.me", "X-Title": "ChensAgent Grader" },
});

const GRADING_RULES = `GRADING RULES:
- 100/100: All key points covered with good detail
- 85-95/100: All key points but thin detail
- 65-80/100: Some key points missing
- 50/100 or below: Minimal effort or off-topic
- null: Nothing submitted — skip
- Comments: MAXIMUM 15 words, human professor tone, individualized per student
- No grammar/spelling deductions
- Implementation OR thorough explanation = full credit for hands-on components`;

export interface GradeEntry {
  user_id: string;
  name: string;
  raw_score: number | null;
  comment: string;
  late: boolean;
  seconds_late: number;
  notes: string;
}

export interface GradePreview {
  course_canvas_id: string;
  assignment_canvas_id: string;
  assignment_title: string;
  points_possible: number;
  grades: GradeEntry[];
  model_used: string;
  input_tokens: number;
  output_tokens: number;
}

export async function gradeAssignmentPreview(
  courseCanvasId: string,
  assignmentCanvasId: string,
  canvasToken: string,
  model: string = "openrouter/auto"
): Promise<GradePreview> {
  setActiveToken(canvasToken);
  try {
    const assignment: any = await canvasRequest(`/courses/${courseCanvasId}/assignments/${assignmentCanvasId}`);
    const submissions: any[] = await canvasRequest(
      `/courses/${courseCanvasId}/assignments/${assignmentCanvasId}/submissions?per_page=100&include[]=user&include[]=submission_comments`
    );
    const toGrade = submissions.filter(s =>
      s.workflow_state === "submitted" || s.workflow_state === "graded" || s.workflow_state === "pending_review"
    );

    if (!toGrade.length) {
      return {
        course_canvas_id: courseCanvasId,
        assignment_canvas_id: assignmentCanvasId,
        assignment_title: assignment.name,
        points_possible: assignment.points_possible,
        grades: [],
        model_used: model,
        input_tokens: 0,
        output_tokens: 0,
      };
    }

    // Extract text content for each submission (including attachments)
    const activeToken = canvasToken;
    const submissionsText = (await Promise.all(toGrade.map(async sub => {
      const name = sub.user?.name ?? `Student ${sub.user_id}`;
      const lateStr = sub.late ? `YES (${Math.round((sub.seconds_late ?? 0) / 3600)}hrs late)` : "No";
      const comment = sub.submission_comments?.[0]?.comment;

      let content = "";
      if (sub.body) content += sub.body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      if (sub.url) content += ` URL: ${sub.url}`;

      // Download and extract text from each attachment
      if (sub.attachments?.length) {
        const attachTexts = await Promise.all(
          sub.attachments.map((a: any) => extractAttachmentText(a.url, a.display_name, activeToken))
        );
        content += "\n" + attachTexts.join("\n");
      }

      if (!content.trim()) content = "[No text content]";
      return `---\nStudent: ${name} (Canvas UID: ${sub.user_id})\nSubmitted: ${sub.submitted_at ?? "unknown"} | Late: ${lateStr}${comment ? `\nStudent comment: "${comment}"` : ""}\nContent: ${content.trim()}\n---`;
    }))).join("\n");

    const descText = assignment.description
      ? assignment.description.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000)
      : "No description";

    const prompt = `You are a grading assistant for a professor at Frostburg State University.\n\nASSIGNMENT: ${assignment.name}\nDESCRIPTION: ${descText}\nPOINTS POSSIBLE: ${assignment.points_possible}\n\n${GRADING_RULES}\n\nSUBMISSIONS:\n${submissionsText}\n\nReturn ONLY a valid JSON array (no markdown fences, no explanation):\n[\n  {\n    "user_id": "12345",\n    "name": "Student Name",\n    "raw_score": 95,\n    "comment": "Up to 15 words of feedback here.",\n    "notes": "Any grading notes for professor"\n  }\n]\n\nInclude ALL ${toGrade.length} students. raw_score must be 0-${assignment.points_possible} or null.`;

    const resp = await openrouter.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2000,
      temperature: 0.3,
    });

    const raw = resp.choices[0]?.message?.content ?? "[]";
    const inputTokens = resp.usage?.prompt_tokens ?? 0;
    const outputTokens = resp.usage?.completion_tokens ?? 0;

    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);

    const grades: GradeEntry[] = parsed.map((g: any) => {
      const sub = toGrade.find(s => String(s.user_id) === String(g.user_id));
      return {
        user_id: String(g.user_id),
        name: g.name ?? sub?.user?.name ?? `Student ${g.user_id}`,
        raw_score: g.raw_score ?? null,
        comment: g.comment ?? "",
        late: sub?.late ?? false,
        seconds_late: sub?.seconds_late ?? 0,
        notes: g.notes ?? "",
      };
    });

    return {
      course_canvas_id: courseCanvasId,
      assignment_canvas_id: assignmentCanvasId,
      assignment_title: assignment.name,
      points_possible: assignment.points_possible,
      grades,
      model_used: model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    };
  } finally {
    setActiveToken(null);
  }
}

export async function applyGrades(
  courseCanvasId: string,
  assignmentCanvasId: string,
  canvasToken: string,
  grades: GradeEntry[]
): Promise<{ applied: number; errors: string[] }> {
  setActiveToken(canvasToken);
  const errors: string[] = [];
  let applied = 0;
  try {
    for (const g of grades) {
      if (g.raw_score === null) continue;
      try {
        await canvasRequest(
          `/courses/${courseCanvasId}/assignments/${assignmentCanvasId}/submissions/${g.user_id}`,
          {
            method: "PUT",
            body: {
              submission: { posted_grade: String(g.raw_score) },
              ...(g.comment ? { comment: { text_comment: g.comment } } : {}),
            },
          }
        );
        applied++;
      } catch (err) {
        errors.push(`${g.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    setActiveToken(null);
  }
  return { applied, errors };
}
