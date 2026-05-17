import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

export const CLIPZ_DIR = join(homedir(), ".clipz");
export const CONFIG_PATH = join(CLIPZ_DIR, "config.json");
export const LOCAL_DB_PATH = join(CLIPZ_DIR, "history.db");
export const ICLOUD_DRIVE_PATH = join(
  homedir(),
  "Library",
  "Mobile Documents",
  "com~apple~CloudDocs",
);
export const ICLOUD_DB_DIR = join(ICLOUD_DRIVE_PATH, "Clipz");
export const ICLOUD_DB_PATH = join(ICLOUD_DB_DIR, "history.db");

export interface ClipzConfig {
  syncToICloud: boolean;
}

export function readConfig(): ClipzConfig {
  try {
    const parsed = JSON.parse(
      readFileSync(CONFIG_PATH, "utf8"),
    ) as Partial<ClipzConfig>;
    return { syncToICloud: parsed.syncToICloud !== false };
  } catch {
    return { syncToICloud: true };
  }
}

export function writeConfig(config: ClipzConfig) {
  mkdirSync(CLIPZ_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function copyDBIfNeeded(source: string, target: string) {
  if (!existsSync(source) || existsSync(target)) return;
  copyFileSync(source, target);
}

export function setICloudSyncEnabled(enabled: boolean) {
  writeConfig({ syncToICloud: enabled });

  if (enabled) {
    try {
      mkdirSync(ICLOUD_DB_DIR, { recursive: true });
      copyDBIfNeeded(LOCAL_DB_PATH, ICLOUD_DB_PATH);
    } catch {
      // The resolver will fall back to local if iCloud is unavailable.
    }
  } else {
    try {
      mkdirSync(CLIPZ_DIR, { recursive: true });
      copyDBIfNeeded(ICLOUD_DB_PATH, LOCAL_DB_PATH);
    } catch {
      // Local fallback will create a new DB if copying is not possible.
    }
  }
}

export function resolveDBPath(): string {
  if (!readConfig().syncToICloud) return LOCAL_DB_PATH;
  if (!existsSync(ICLOUD_DRIVE_PATH)) return LOCAL_DB_PATH;

  try {
    mkdirSync(ICLOUD_DB_DIR, { recursive: true });
    copyDBIfNeeded(LOCAL_DB_PATH, ICLOUD_DB_PATH);
    if (existsSync(ICLOUD_DB_PATH) || !existsSync(LOCAL_DB_PATH)) {
      return ICLOUD_DB_PATH;
    }
  } catch {
    return LOCAL_DB_PATH;
  }

  return LOCAL_DB_PATH;
}

export const DB_PATH = resolveDBPath();

function sqliteExec(dbPath: string, sql: string) {
  const result = spawnSync("/usr/bin/sqlite3", [dbPath, sql], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "sqlite3 failed");
  }
}

export function ensureDBSchema(dbPath: string) {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  sqliteExec(
    dbPath,
    `
CREATE TABLE IF NOT EXISTS clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text',
  is_sensitive INTEGER NOT NULL DEFAULT 0,
  source_app TEXT,
  source_url TEXT,
  source_file TEXT,
  content_html TEXT,
  content_lang TEXT,
  copy_count INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clips_hash ON clips(content_hash);
CREATE INDEX IF NOT EXISTS idx_clips_ts ON clips(created_at DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS clips_fts USING fts5(
  content, content='clips', content_rowid='id', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS clips_ai AFTER INSERT ON clips BEGIN
  INSERT INTO clips_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS clips_ad AFTER DELETE ON clips BEGIN
  INSERT INTO clips_fts(clips_fts, rowid, content)
    VALUES ('delete', old.id, old.content);
END;
`,
  );

  for (const sql of [
    "ALTER TABLE clips ADD COLUMN source_url TEXT",
    "ALTER TABLE clips ADD COLUMN source_file TEXT",
    "ALTER TABLE clips ADD COLUMN content_html TEXT",
    "ALTER TABLE clips ADD COLUMN content_lang TEXT",
    "ALTER TABLE clips ADD COLUMN copy_count INTEGER NOT NULL DEFAULT 1",
  ]) {
    try {
      sqliteExec(dbPath, sql);
    } catch {
      // SQLite has no ADD COLUMN IF NOT EXISTS. Existing columns are fine.
    }
  }
}

ensureDBSchema(DB_PATH);

export interface Clip {
  id: number;
  content: string;
  content_type: string;
  is_sensitive: number;
  source_app: string | null;
  source_url: string | null;
  source_file: string | null;
  content_html: string | null;
  content_lang: string | null;
  created_at: number;
  copy_count?: number;
}

export interface SearchFilters {
  source_app?: string;
  since?: number;
  until?: number;
  content_type?: string;
  semantic?: string;
}

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

export function buildSearchSQL(query: string): string {
  if (!query.trim()) {
    return `
      SELECT id, content, content_type, is_sensitive, source_app, source_url, source_file, content_html, content_lang, created_at, copy_count
      FROM clips
      ORDER BY created_at DESC
      LIMIT 200
    `;
  }
  // LIKE is reliable across all SQLite versions — no FTS5 dependency
  return `
    SELECT id, content, content_type, is_sensitive, source_app, source_url, source_file, content_html, content_lang, created_at, copy_count
    FROM clips
    WHERE content LIKE '%${esc(query.trim())}%'
    ORDER BY created_at DESC
    LIMIT 60
  `;
}

export function buildFilterSQL(filters: SearchFilters): string {
  const conditions: string[] = [];

  if (filters.source_app)
    conditions.push(`source_app LIKE '%${esc(filters.source_app)}%'`);
  if (filters.since) conditions.push(`created_at >= ${filters.since}`);
  if (filters.until) conditions.push(`created_at <= ${filters.until}`);
  if (filters.content_type)
    conditions.push(`content_type = '${esc(filters.content_type)}'`);
  if (filters.semantic)
    conditions.push(`content LIKE '%${esc(filters.semantic)}%'`);

  if (conditions.length === 0) return buildSearchSQL("");

  return `
    SELECT id, content, content_type, is_sensitive, source_app, source_url, source_file, content_html, content_lang, created_at, copy_count
    FROM clips
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT 60
  `;
}
