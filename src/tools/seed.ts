/**
 * Seeds the core Canvas LMS tools into the registry on startup.
 * These are human-authored (tier GREEN/YELLOW) and pre-approved.
 */

import { db } from "../db/client.js";
import { registerTool } from "./registry.js";
import { ToolStatus, ToolTier } from "@prisma/client";

const CORE_TOOLS = [
  {
    name: "canvas_list_courses",
    description: "Lists all active courses for the authenticated teacher",
    tier: ToolTier.GREEN,
    schema: {
      input: { enrollment_type: { type: "string", description: "Filter by role e.g. teacher" } },
      output: { courses: { type: "array", description: "Array of course objects" } },
    },
    code: `
const courses = await canvasRequest('/courses?enrollment_type=teacher&enrollment_state=active&per_page=50');
return { courses: courses.map(c => ({ id: c.id, name: c.name, course_code: c.course_code, term: c.term?.name })) };`,
    tests: [{ input: {}, expectedOutput: { courses: [] } }],
    evolutionReason: "Core tool — seeded at startup",
    createdBy: "human",
  },
  {
    name: "canvas_get_assignments",
    description: "Gets all assignments for a specific course",
    tier: ToolTier.GREEN,
    schema: {
      input: { course_id: { type: "string", description: "Canvas course ID" } },
      output: { assignments: { type: "array", description: "Array of assignment objects" } },
    },
    code: `
const assignments = await canvasRequest('/courses/' + input.course_id + '/assignments?per_page=50');
return { assignments };`,
    tests: [{ input: { course_id: "123" }, expectedOutput: { assignments: [] } }],
    evolutionReason: "Core tool — seeded at startup",
    createdBy: "human",
  },
  {
    name: "canvas_grade_submission",
    description: "Posts a grade and optional comment for a student submission",
    tier: ToolTier.YELLOW,
    schema: {
      input: {
        course_id: { type: "string" },
        assignment_id: { type: "string" },
        user_id: { type: "string" },
        grade: { type: "number" },
        comment: { type: "string", description: "Optional grading comment" },
      },
      output: { submission_id: { type: "string" }, posted_grade: { type: "string" } },
    },
    code: `
const body = {
  submission: { posted_grade: String(input.grade) },
  comment: input.comment ? { text_comment: input.comment } : undefined,
};
const result = await canvasRequest(
  '/courses/' + input.course_id + '/assignments/' + input.assignment_id + '/submissions/' + input.user_id,
  { method: 'PUT', body }
);
return { submission_id: result.id, posted_grade: result.posted_grade };`,
    tests: [{ input: { course_id: "1", assignment_id: "2", user_id: "3", grade: 95 }, expectedOutput: { submission_id: "mock_id_123" } }],
    evolutionReason: "Core tool — seeded at startup",
    createdBy: "human",
  },
  {
    name: "canvas_list_submissions",
    description: "Lists all student submissions for an assignment, with grades",
    tier: ToolTier.GREEN,
    schema: {
      input: {
        course_id: { type: "string" },
        assignment_id: { type: "string" },
        workflow_state: { type: "string", description: "Filter: submitted|unsubmitted|graded|pending_review" },
      },
      output: { submissions: { type: "array" } },
    },
    code: `
const state = input.workflow_state ? '&workflow_state=' + input.workflow_state : '';
const submissions = await canvasRequest(
  '/courses/' + input.course_id + '/assignments/' + input.assignment_id + '/submissions?per_page=50&include[]=user' + state
);
return { submissions };`,
    tests: [{ input: { course_id: "1", assignment_id: "2" }, expectedOutput: { submissions: [] } }],
    evolutionReason: "Core tool — seeded at startup",
    createdBy: "human",
  },
  {
    name: "canvas_create_assignment",
    description: "Creates and optionally publishes a new assignment in a course",
    tier: ToolTier.YELLOW,
    schema: {
      input: {
        course_id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        points_possible: { type: "number" },
        due_at: { type: "string", description: "ISO 8601 datetime" },
        published: { type: "boolean" },
      },
      output: { assignment_id: { type: "string" }, url: { type: "string" } },
    },
    code: `
const result = await canvasRequest('/courses/' + input.course_id + '/assignments', {
  method: 'POST',
  body: {
    assignment: {
      name: input.name,
      description: input.description,
      points_possible: input.points_possible ?? 100,
      due_at: input.due_at,
      published: input.published ?? false,
      submission_types: ['online_upload', 'online_text_entry'],
    }
  }
});
return { assignment_id: String(result.id), url: result.html_url };`,
    tests: [{ input: { course_id: "1", name: "Test", description: "Test", points_possible: 100 }, expectedOutput: { assignment_id: "mock_id_123" } }],
    evolutionReason: "Core tool — seeded at startup",
    createdBy: "human",
  },
  {
    name: "canvas_post_announcement",
    description: "Posts an announcement to all students in a course",
    tier: ToolTier.YELLOW,
    schema: {
      input: {
        course_id: { type: "string" },
        title: { type: "string" },
        message: { type: "string" },
      },
      output: { announcement_id: { type: "string" } },
    },
    code: `
const result = await canvasRequest('/courses/' + input.course_id + '/discussion_topics', {
  method: 'POST',
  body: {
    title: input.title,
    message: input.message,
    is_announcement: true,
    published: true,
  }
});
return { announcement_id: String(result.id) };`,
    tests: [{ input: { course_id: "1", title: "Test", message: "Hello" }, expectedOutput: { announcement_id: "mock_id_123" } }],
    evolutionReason: "Core tool — seeded at startup",
    createdBy: "human",
  },
  {
    name: "canvas_get_ungraded",
    description: "Finds all ungraded student submissions across an assignment",
    tier: ToolTier.GREEN,
    schema: {
      input: { course_id: { type: "string" }, assignment_id: { type: "string" } },
      output: { ungraded: { type: "array" }, count: { type: "number" } },
    },
    code: `
const submissions = await canvasRequest(
  '/courses/' + input.course_id + '/assignments/' + input.assignment_id + '/submissions?workflow_state=submitted&per_page=50&include[]=user'
);
const ungraded = submissions.filter((s) => s.grade == null);
return { ungraded, count: ungraded.length };`,
    tests: [{ input: { course_id: "1", assignment_id: "2" }, expectedOutput: { ungraded: [], count: 0 } }],
    evolutionReason: "Core tool — seeded at startup",
    createdBy: "human",
  },
  {
    name: "canvas_create_quiz",
    description: "Creates a quiz with questions in a Canvas course",
    tier: ToolTier.YELLOW,
    schema: {
      input: {
        course_id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        time_limit: { type: "number", description: "Minutes" },
        published: { type: "boolean" },
        questions: { type: "array", description: "Array of {question_text, question_type, points_possible, answers}" },
      },
      output: { quiz_id: { type: "string" }, url: { type: "string" } },
    },
    code: `
const quiz = await canvasRequest('/courses/' + input.course_id + '/quizzes', {
  method: 'POST',
  body: {
    quiz: {
      title: input.title,
      description: input.description,
      quiz_type: 'assignment',
      time_limit: input.time_limit ?? 60,
      published: input.published ?? false,
    }
  }
});
if (input.questions && input.questions.length) {
  for (const q of input.questions) {
    await canvasRequest('/courses/' + input.course_id + '/quizzes/' + quiz.id + '/questions', {
      method: 'POST',
      body: { quiz_question: q }
    });
  }
}
return { quiz_id: String(quiz.id), url: quiz.html_url };`,
    tests: [{ input: { course_id: "1", title: "Test Quiz", description: "Quiz", questions: [] }, expectedOutput: { quiz_id: "mock_id_123" } }],
    evolutionReason: "Core tool — seeded at startup",
    createdBy: "human",
  },
  {
    name: "canvas_create_page",
    description: "Creates a reading material page in a Canvas course",
    tier: ToolTier.YELLOW,
    schema: {
      input: {
        course_id: { type: "string" },
        title: { type: "string" },
        body: { type: "string", description: "HTML content" },
        published: { type: "boolean" },
      },
      output: { page_url: { type: "string" }, title: { type: "string" } },
    },
    code: `
const result = await canvasRequest('/courses/' + input.course_id + '/pages', {
  method: 'POST',
  body: {
    wiki_page: {
      title: input.title,
      body: input.body,
      published: input.published ?? false,
    }
  }
});
return { page_url: result.html_url, title: result.title };`,
    tests: [{ input: { course_id: "1", title: "Week 1 Reading", body: "<p>Content</p>" }, expectedOutput: { page_url: "mock_id_123" } }],
    evolutionReason: "Core tool — seeded at startup",
    createdBy: "human",
  },
];

let seeded = false;

export async function seedCoreTools(force = false): Promise<void> {
  if (seeded && !force) return;
  if (!force) seeded = true;

  console.log(`[SEED] ${force ? "Force re-seeding" : "Checking"} core tools...`);
  for (const def of CORE_TOOLS) {
    const existing = await db.tool.findUnique({ where: { name: def.name } });
    if (!existing) {
      await registerTool(def, true);
      await db.tool.update({
        where: { name: def.name },
        data: { status: ToolStatus.APPROVED, approvedBy: "human", approvedAt: new Date() },
      });
      console.log(`[SEED] ✅ Registered: ${def.name}`);
    } else if (force) {
      // Update code + schema in place
      await db.tool.update({
        where: { name: def.name },
        data: {
          code: def.code,
          schema: def.schema as object,
          description: def.description,
          version: { increment: 1 },
          status: ToolStatus.APPROVED,
        },
      });
      console.log(`[SEED] 🔄 Updated: ${def.name}`);
    }
  }
  console.log("[SEED] Core tools ready.");
}
