import { spawnSync } from "child_process";
import { Clip } from "./db";

export interface SemanticPrefs {
  ollamaUrl: string;
  embeddingModel: string;
}

interface EmbeddingRow {
  clip_id: number;
  content_hash: string;
  embedding: string;
}

interface RawClip extends Clip {
  content_hash: string;
}

export interface SemanticResult {
  clip: Clip;
  score: number;
}

const SEMANTIC_COLS =
  "id,content,content_hash,content_type,is_sensitive,source_app,source_url,source_file,content_html,content_lang,created_at,copy_count";

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlite(dbPath: string, sql: string): string {
  const result = spawnSync("/usr/bin/sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "sqlite3 failed");
  }
  return result.stdout.trim();
}

function sqliteExec(dbPath: string, sql: string) {
  const result = spawnSync("/usr/bin/sqlite3", [dbPath, sql], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "sqlite3 failed");
  }
}

function queryJSON<T>(dbPath: string, sql: string): T[] {
  const out = sqlite(dbPath, sql);
  return out ? (JSON.parse(out) as T[]) : [];
}

export function ensureEmbeddingsTable(dbPath: string) {
  sqliteExec(
    dbPath,
    `
CREATE TABLE IF NOT EXISTS clip_embeddings (
  clip_id INTEGER PRIMARY KEY,
  content_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  embedding TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_clip_embeddings_model ON clip_embeddings(model);
`,
  );
}

async function embed(text: string, prefs: SemanticPrefs): Promise<number[]> {
  const model = prefs.embeddingModel || "nomic-embed-text";
  const res = await fetch(`${prefs.ollamaUrl}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: text.slice(0, 4000),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 404 && body.includes("not found")) {
      throw new Error(`Embedding model missing. Run: ollama pull ${model}`);
    }
    throw new Error(
      `Ollama embeddings HTTP ${res.status}${body ? `: ${body}` : ""}`,
    );
  }
  const json = (await res.json()) as { embedding?: number[] };
  if (!Array.isArray(json.embedding)) throw new Error("No embedding returned");
  return json.embedding;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    aMag += a[i] * a[i];
    bMag += b[i] * b[i];
  }
  if (!aMag || !bMag) return 0;
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
}

function clipToEmbeddingText(clip: RawClip): string {
  const app = clip.source_app ? `App: ${clip.source_app}\n` : "";
  const url = clip.source_url ? `URL: ${clip.source_url}\n` : "";
  const file = clip.source_file ? `File: ${clip.source_file}\n` : "";
  const lang = clip.content_lang ? `Language: ${clip.content_lang}\n` : "";
  return `${app}${url}${file}${lang}Type: ${clip.content_type}\nContent:\n${clip.content}`;
}

async function backfillEmbeddings(
  dbPath: string,
  clips: RawClip[],
  prefs: SemanticPrefs,
) {
  const model = prefs.embeddingModel || "nomic-embed-text";
  const existing = queryJSON<EmbeddingRow>(
    dbPath,
    `SELECT clip_id, content_hash, embedding FROM clip_embeddings WHERE model = ${sqlString(model)}`,
  );
  const existingById = new Map(existing.map((row) => [row.clip_id, row]));

  for (const clip of clips) {
    const cached = existingById.get(clip.id);
    if (cached?.content_hash === clip.content_hash) continue;

    const vector = await embed(clipToEmbeddingText(clip), prefs);
    sqliteExec(
      dbPath,
      `
INSERT OR REPLACE INTO clip_embeddings (clip_id, content_hash, model, embedding, created_at)
VALUES (${clip.id}, ${sqlString(clip.content_hash)}, ${sqlString(model)}, ${sqlString(JSON.stringify(vector))}, unixepoch());
`,
    );
  }
}

export async function semanticSearch(
  dbPath: string,
  query: string,
  prefs: SemanticPrefs,
  limit = 40,
): Promise<SemanticResult[]> {
  if (!query.trim()) return [];
  ensureEmbeddingsTable(dbPath);

  const candidates = queryJSON<RawClip>(
    dbPath,
    `
SELECT ${SEMANTIC_COLS}
FROM clips
WHERE is_sensitive = 0
ORDER BY created_at DESC
LIMIT 400;
`,
  );
  if (candidates.length === 0) return [];

  await backfillEmbeddings(dbPath, candidates, prefs);

  const model = prefs.embeddingModel || "nomic-embed-text";
  const rows = queryJSON<EmbeddingRow>(
    dbPath,
    `
SELECT clip_id, content_hash, embedding
FROM clip_embeddings
WHERE model = ${sqlString(model)};
`,
  );
  const embeddingsById = new Map(
    rows.map((row) => [row.clip_id, JSON.parse(row.embedding) as number[]]),
  );
  const queryEmbedding = await embed(query, prefs);

  return candidates
    .map((clip) => ({
      clip,
      score: cosine(queryEmbedding, embeddingsById.get(clip.id) ?? []),
    }))
    .filter((result) => result.score > 0.2)
    .sort((a, b) => b.score - a.score || b.clip.created_at - a.clip.created_at)
    .slice(0, limit);
}
