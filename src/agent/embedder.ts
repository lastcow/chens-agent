/**
 * Text embedding using Gemini embedding API.
 * Used for tool deduplication similarity search.
 */

const GEMINI_KEY = process.env.GEMINI_API_KEY!;
const EMBED_MODEL = "gemini-embedding-001";
const EMBED_DIM = 1024;

export async function embedText(text: string): Promise<number[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text }] },
        outputDimensionality: EMBED_DIM,
      }),
    }
  );

  if (!res.ok) {
    const err = await res.json() as { error?: { message?: string } };
    throw new Error(`Embedding failed: ${err?.error?.message ?? res.status}`);
  }

  const data = await res.json() as { embedding?: { values?: number[] } };
  const values = data?.embedding?.values;
  if (!values?.length) throw new Error("No embedding values returned");
  return values;
}

export async function cosineSimilarity(a: number[], b: number[]): Promise<number> {
  const dot = a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);
  const magA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  const magB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
  return dot / (magA * magB);
}
