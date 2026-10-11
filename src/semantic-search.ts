import { spawnSync } from "child_process";
import { createConnection } from "net";
import { join } from "path";
import { Clip, CLIPZ_DIR } from "./db";

// The daemon runs EmbeddingGemma 2 locally, embeds every clip as it's copied and
// answers searches over a user-only Unix socket. See daemon/clipz-daemon.swift.
const SOCKET_PATH = join(CLIPZ_DIR, "daemon.sock");

export interface SemanticResult {
  clip: Clip;
  score: number;
}

interface DaemonHit {
  id: number;
  score: number;
}

type DaemonResponse =
  | { ok: true; results: DaemonHit[]; indexing: boolean; indexed: number }
  | { ok: false; error: string };

const CLIP_COLS =
  "id,content,content_type,is_sensitive,source_app,source_url,source_file,content_html,content_lang,created_at,copy_count";

function askDaemon(
  request: object,
  timeoutMs = 5_000,
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(SOCKET_PATH);
    let buffer = "";
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error("Clipz daemon did not respond"));
    });
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as DaemonResponse);
      } catch {
        reject(new Error("Clipz daemon sent an invalid response"));
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? new Error("Clipz daemon isn't running")
          : error,
      );
    });
  });
}

function clipsById(dbPath: string, ids: number[]): Map<number, Clip> {
  if (ids.length === 0) return new Map();
  const result = spawnSync(
    "/usr/bin/sqlite3",
    [
      "-json",
      dbPath,
      `SELECT ${CLIP_COLS} FROM clips WHERE id IN (${ids.map(Number).join(",")})`,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || "sqlite3 failed");
  const rows = result.stdout.trim()
    ? (JSON.parse(result.stdout) as Clip[])
    : [];
  return new Map(rows.map((clip) => [clip.id, clip]));
}

export async function semanticSearch(
  dbPath: string,
  query: string,
  limit = 40,
): Promise<SemanticResult[]> {
  if (!query.trim()) return [];

  const response = await askDaemon({ op: "search", query, limit });
  if (!response.ok) throw new Error(response.error);

  // Clips deleted since the daemon last refreshed its index simply drop out here.
  const clips = clipsById(
    dbPath,
    response.results.map((hit) => hit.id),
  );
  return response.results.flatMap((hit) => {
    const clip = clips.get(hit.id);
    return clip ? [{ clip, score: hit.score }] : [];
  });
}
