/**
 * Grade Queue Processor
 * Reads pending prof_requests → grades each submission via LLM → writes to prof_grade_staging.
 */

import OpenAI from "openai";
import { neon } from "@neondatabase/serverless";
import { createDecipheriv } from "crypto";
import { extractAttachmentText } from "./index.js";

const sql = neon(process.env.DATABASE_URL!);
const CANVAS_BASE = process.env.CANVAS_BASE_URL ?? "https://frostburg.instructure.com";
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET ?? "";
const GRADING_MODEL = process.env.GRADING_MODEL ?? "anthropic/claude-haiku-4-5";

const openrouter = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY!,
  defaultHeaders: { "HTTP-Referer": "https://chen.me", "X-Title": "ChensAgent" },
});

function decryptToken(encrypted: string): string {
  const [ivHex, tagHex, cipherHex] = encrypted.split(":");
  const key = Buffer.from(ENCRYPTION_SECRET, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(cipherHex, "hex")), decipher.final()]).toString("utf8");
}

async function canvasFetch(path: string, token: string): Promise<any> {
  const res = await fetch(`${CANVAS_BASE}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Canvas ${path}: HTTP ${res.status}`);
  return res.json();
}

async function gradeSingle(opts: {
  assignmentName: string;
  assignmentDescription: string;
  pointsPossible: number;
  studentName: string;
  submissionText: string;
  studentComment: string;
}): Promise<{ score: number; comment: string }> {
  const prompt = `You are a university professor grading a student assignment.

Assignment: ${opts.assignmentName}
Points Possible: ${opts.pointsPossible}
Instructions:
${opts.assignmentDescription.replace(/<[^>]+>/g, " ").slice(0, 2000)}
${opts.studentComment ? `\nStudent's Note: ${opts.studentComment}` : ""}

Student: ${opts.studentName}
Submission:
---
${opts.submissionText.slice(0, 6000)}
---

Evaluate this submission thoroughly and respond ONLY with valid JSON:
{"score": <number 0-${opts.pointsPossible}>, "comment": "<concise professor feedback, max 20 words>"}`;

  const resp = await openrouter.chat.completions.create({
    model: GRADING_MODEL,
    max_tokens: 200,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = (resp.choices[0]?.message?.content ?? "{}").replace(/```json\n?|\n?```/g, "").trim();
  try {
    const parsed = JSON.parse(raw);
    return {
      score: Math.min(Math.max(0, Number(parsed.score) || 0), opts.pointsPossible),
      comment: String(parsed.comment ?? "").slice(0, 150),
    };
  } catch {
    return { score: 0, comment: "AI could not parse submission" };
  }
}

export async function processGradeQueue(): Promise<{
  processed: number; skipped: number; errors: string[];
}> {
  const errors: string[] = [];
  let processed = 0;
  let skipped = 0;

  // 1. Claim pending requests (lock with in_progress)
  const pendingRequests = await sql.query<{
    id: string; user_id: string; assignment_id: number;
    course_canvas_id: number; assignment_name: string; course_name: string;
  }>(
    `UPDATE prof_requests SET status='in_progress'
     WHERE id IN (
       SELECT id FROM prof_requests WHERE status='pending' ORDER BY created_at LIMIT 10
     )
     RETURNING id, user_id, assignment_id, course_canvas_id, assignment_name, course_name`,
    []
  );

  if (!pendingRequests.length) return { processed: 0, skipped: 0, errors: [] };

  for (const req of pendingRequests) {
    try {
      // 2. Get Canvas token
      const tokenRows = await sql.query<{ canvas_token: string }>(
        `SELECT canvas_token FROM user_profile WHERE user_id = $1`, [req.user_id]
      );
      const enc = tokenRows[0]?.canvas_token;
      if (!enc) {
        errors.push(`${req.assignment_name}: no Canvas token for user`);
        await sql.query(`UPDATE prof_requests SET status='pending' WHERE id=$1`, [req.id]);
        skipped++; continue;
      }
      const canvasToken = decryptToken(enc);

      // 3. Get assignment details
      const [asg] = await sql.query<{
        canvas_id: number; name: string; description: string; points_possible: number;
      }>(
        `SELECT canvas_id, name, description, points_possible FROM prof_assignments WHERE id=$1`,
        [req.assignment_id]
      );
      if (!asg) {
        errors.push(`${req.assignment_name}: assignment not found in DB`);
        skipped++; continue;
      }

      // 4. Get ungraded submissions not already in staging
      const subs = await sql.query<{
        sub_id: number; canvas_uid: number; student_name: string;
        workflow_state: string; late: boolean; student_comment: string;
      }>(
        `SELECT sub.id AS sub_id, s.canvas_uid, s.name AS student_name,
                sub.workflow_state, sub.late, sub.student_comment
         FROM prof_submissions sub
         JOIN prof_students s ON s.id = sub.student_id
         LEFT JOIN prof_grades g ON g.submission_id = sub.id
         LEFT JOIN prof_grade_staging pgs ON pgs.submission_id = sub.id AND pgs.status='pending'
         WHERE sub.assignment_id = $1
           AND sub.workflow_state IN ('submitted','pending_review')
           AND g.id IS NULL
           AND pgs.id IS NULL`,
        [req.assignment_id]
      );

      if (!subs.length) {
        await sql.query(`UPDATE prof_requests SET status='completed' WHERE id=$1`, [req.id]);
        skipped++; continue;
      }

      // 5. Grade each submission
      let staged = 0;
      for (const sub of subs) {
        try {
          // Fetch Canvas submission for body/attachments
          const canvasSub = await canvasFetch(
            `/courses/${req.course_canvas_id}/assignments/${asg.canvas_id}/submissions/${sub.canvas_uid}?include[]=attachments`,
            canvasToken
          );

          let submissionText = "";
          if (canvasSub.body) submissionText += canvasSub.body.replace(/<[^>]+>/g, " ").trim() + "\n";
          if (canvasSub.url) submissionText += `URL: ${canvasSub.url}\n`;

          for (const att of canvasSub.attachments ?? []) {
            const txt = await extractAttachmentText(att.url, att.filename, canvasToken);
            submissionText += `\n[File: ${att.filename}]\n${txt}\n`;
          }

          if (!submissionText.trim()) submissionText = "[No submission content]";

          const result = await gradeSingle({
            assignmentName: asg.name,
            assignmentDescription: asg.description ?? "",
            pointsPossible: Number(asg.points_possible),
            studentName: sub.student_name,
            submissionText,
            studentComment: sub.student_comment ?? "",
          });

          // Insert into staging
          await sql.query(
            `INSERT INTO prof_grade_staging
               (request_id, submission_id, student_name, student_canvas_uid, assignment_name,
                course_name, raw_score, final_score, late_penalty, grader_comment, ai_model, status, user_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,'pending',$11)
             ON CONFLICT DO NOTHING`,
            [
              req.id, sub.sub_id, sub.student_name, sub.canvas_uid,
              req.assignment_name, req.course_name,
              result.score, result.score,
              result.comment, GRADING_MODEL, req.user_id,
            ]
          );
          staged++;
        } catch (subErr: any) {
          errors.push(`${sub.student_name}: ${subErr.message}`);
        }
      }

      if (staged > 0) {
        processed++;
        console.log(`[queue] ✓ ${req.assignment_name}: ${staged}/${subs.length} staged`);
      } else {
        skipped++;
      }
      // Leave status as in_progress — requester must approve/reject

    } catch (reqErr: any) {
      errors.push(`Request ${req.id}: ${reqErr.message}`);
      await sql.query(`UPDATE prof_requests SET status='pending' WHERE id=$1`, [req.id]);
    }
  }

  return { processed, skipped, errors };
}
