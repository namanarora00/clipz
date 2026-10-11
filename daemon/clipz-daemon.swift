import Foundation
import AppKit
import Accelerate
import SQLite3
import llama

// MARK: - SQLite

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

final class DB {
    private var handle: OpaquePointer?

    init(path: String, syncsAcrossDevices: Bool) {
        guard sqlite3_open(path, &handle) == SQLITE_OK else {
            fatalError("Cannot open database at \(path)")
        }
        exec(syncsAcrossDevices ? "PRAGMA journal_mode=DELETE" : "PRAGMA journal_mode=WAL")
        exec("PRAGMA synchronous=NORMAL")
        exec("PRAGMA cache_size=-32000")
        exec("PRAGMA busy_timeout=5000")
        migrate()
    }

    deinit { sqlite3_close(handle) }

    @discardableResult
    private func exec(_ sql: String) -> Bool {
        return sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK
    }

    private func migrate() {
        exec("""
        CREATE TABLE IF NOT EXISTS clips (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            content      TEXT    NOT NULL,
            content_hash TEXT    NOT NULL,
            content_type TEXT    NOT NULL DEFAULT 'text',
            is_sensitive INTEGER NOT NULL DEFAULT 0,
            source_app   TEXT,
            source_url   TEXT,
            source_file  TEXT,
            created_at   INTEGER NOT NULL DEFAULT (unixepoch())
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
        """)
        // Non-destructive migration for existing DBs — silently ignored if columns exist
        exec("ALTER TABLE clips ADD COLUMN source_url TEXT")
        exec("ALTER TABLE clips ADD COLUMN source_file TEXT")
        exec("ALTER TABLE clips ADD COLUMN content_html TEXT")
        exec("ALTER TABLE clips ADD COLUMN content_lang TEXT")
        exec("ALTER TABLE clips ADD COLUMN copy_count INTEGER NOT NULL DEFAULT 1")
        exec("""
        CREATE TABLE IF NOT EXISTS clip_embeddings (
            clip_id      INTEGER PRIMARY KEY,
            content_hash TEXT    NOT NULL,
            model        TEXT    NOT NULL,
            embedding    BLOB    NOT NULL,
            created_at   INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_clip_embeddings_model ON clip_embeddings(model);
        CREATE TRIGGER IF NOT EXISTS clip_embeddings_ad AFTER DELETE ON clips BEGIN
            DELETE FROM clip_embeddings WHERE clip_id = old.id;
        END;
        """)
    }

    func insert(content: String, hash: String, type: String, sensitive: Bool,
                app: String?, url: String?, file: String?,
                html: String?, lang: String?) {
        let sql = """
        INSERT INTO clips
            (content, content_hash, content_type, is_sensitive, source_app, source_url, source_file, content_html, content_lang)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(content_hash) DO UPDATE SET
            copy_count = copy_count + 1,
            created_at = unixepoch()
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, content, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, hash,    -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 3, type,    -1, SQLITE_TRANSIENT)
        sqlite3_bind_int (stmt, 4, sensitive ? 1 : 0)
        bindOptional(stmt, 5, app)
        bindOptional(stmt, 6, url)
        bindOptional(stmt, 7, file)
        bindOptional(stmt, 8, html)
        bindOptional(stmt, 9, lang)
        sqlite3_step(stmt)
    }

    private func bindOptional(_ stmt: OpaquePointer?, _ idx: Int32, _ value: String?) {
        if let v = value { sqlite3_bind_text(stmt, idx, v, -1, SQLITE_TRANSIENT) }
        else              { sqlite3_bind_null(stmt, idx) }
    }
}

// MARK: - Hash

func fastHash(_ s: String) -> String {
    var h: UInt64 = 5381
    for b in s.utf8 { h = h &* 31 &+ UInt64(b) }
    return String(h, radix: 16)
}

// MARK: - AppleScript runner

func runAppleScript(_ source: String, timeout: TimeInterval = 1.5) -> String? {
    // Use a Process to run osascript with a timeout instead of NSAppleScript,
    // so a hung AppleScript doesn't block the daemon indefinitely.
    let task = Process()
    task.launchPath = "/usr/bin/osascript"
    task.arguments  = ["-e", source]

    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError  = Pipe() // discard stderr

    task.launch()

    let done = DispatchSemaphore(value: 0)
    task.terminationHandler = { _ in done.signal() }
    let result = done.wait(timeout: .now() + timeout)

    if result == .timedOut { task.terminate(); return nil }
    guard task.terminationStatus == 0 else { return nil }

    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    let out  = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    return out?.isEmpty == false ? out : nil
}

// MARK: - Source context

private let browsers: Set<String> = [
    "Google Chrome", "Google Chrome Canary", "Chromium",
    "Safari", "Safari Technology Preview",
    "Arc", "Brave Browser", "Microsoft Edge", "Opera", "Vivaldi",
]

private let editors: Set<String> = [
    "Cursor", "Code", "Visual Studio Code",
    "Xcode", "Nova", "Zed", "Sublime Text",
]

struct SourceContext {
    var url:  String?
    var file: String?
}

struct DatabaseLocation {
    var path: String
    var syncsAcrossDevices: Bool
}

func isICloudSyncEnabled(configPath: URL) -> Bool {
    guard let data = try? Data(contentsOf: configPath),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let enabled = json["syncToICloud"] as? Bool else {
        return true
    }
    return enabled
}

func resolveDatabaseLocation() -> DatabaseLocation {
    if let override = ProcessInfo.processInfo.environment["CLIPZ_DB"], !override.isEmpty {
        return DatabaseLocation(path: override, syncsAcrossDevices: false)
    }
    let fm = FileManager.default
    let home = fm.homeDirectoryForCurrentUser
    let localDir = home.appendingPathComponent(".clipz")
    let configPath = localDir.appendingPathComponent("config.json")
    let localDB = localDir.appendingPathComponent("history.db")
    let iCloudDrive = home
        .appendingPathComponent("Library")
        .appendingPathComponent("Mobile Documents")
        .appendingPathComponent("com~apple~CloudDocs")

    try? fm.createDirectory(at: localDir, withIntermediateDirectories: true)

    guard isICloudSyncEnabled(configPath: configPath) else {
        return DatabaseLocation(path: localDB.path, syncsAcrossDevices: false)
    }

    guard fm.fileExists(atPath: iCloudDrive.path) else {
        return DatabaseLocation(path: localDB.path, syncsAcrossDevices: false)
    }

    let cloudDir = iCloudDrive.appendingPathComponent("Clipz")
    let cloudDB = cloudDir.appendingPathComponent("history.db")
    try? fm.createDirectory(at: cloudDir, withIntermediateDirectories: true)

    if !fm.fileExists(atPath: cloudDB.path), fm.fileExists(atPath: localDB.path) {
        for suffix in ["", "-wal", "-shm"] {
            let source = URL(fileURLWithPath: localDB.path + suffix)
            let target = URL(fileURLWithPath: cloudDB.path + suffix)
            if fm.fileExists(atPath: source.path) {
                try? fm.copyItem(at: source, to: target)
            }
        }
    }

    return DatabaseLocation(path: cloudDB.path, syncsAcrossDevices: true)
}

func getSourceContext(for app: String) -> SourceContext {
    if browsers.contains(app) {
        // Chrome-family uses the same AppleScript shape
        let chromeLike = ["Google Chrome", "Google Chrome Canary", "Chromium",
                          "Arc", "Brave Browser", "Microsoft Edge", "Vivaldi"]
        if chromeLike.contains(app) || app.contains("Chrome") {
            let u = runAppleScript("tell application \"\(app)\" to return URL of active tab of front window")
            return SourceContext(url: u)
        }
        if app == "Safari" || app == "Safari Technology Preview" {
            let u = runAppleScript("tell application \"\(app)\" to return URL of current tab of front window")
            return SourceContext(url: u)
        }
    }

    if editors.contains(app) {
        // Try to get the actual file path first (works in Xcode, sometimes others)
        if let path = runAppleScript("tell application \"\(app)\" to return path of document 1"),
           path.hasPrefix("/") {
            return SourceContext(file: path)
        }
        // Fall back to window title — Cursor shows "file.ts — project — Cursor"
        let title = runAppleScript("""
            tell application "System Events"
                tell process "\(app)"
                    if exists front window then return name of front window
                end tell
            end tell
        """)
        return SourceContext(file: title)
    }

    return SourceContext()
}

// MARK: - Secret detection

private let secretPatterns: [NSRegularExpression] = [
    "(?i)(api[_-]?key|secret|password|passwd|token|private[_-]?key|access[_-]?key|client[_-]?secret|refresh[_-]?token)\\s*[:=]\\s*['\\\"]?[^'\\\"\\s]{12,}",
    "(?i)Bearer\\s+[A-Za-z0-9._\\-]{20,}",
    "(?i)(postgres|postgresql|mysql|mongodb(?:\\+srv)?|redis)://[^\\s:]+:[^\\s@]+@[^\\s]+",
    "sk-[A-Za-z0-9]{20,}",
    "sk-ant-[A-Za-z0-9\\-_]{90,}",
    "ghp_[A-Za-z0-9]{36}",
    "github_pat_[A-Za-z0-9_]{82}",
    "ghs_[A-Za-z0-9]{36}",
    "glpat-[A-Za-z0-9\\-_]{20,}",
    "npm_[A-Za-z0-9]{36}",
    "pypi-[A-Za-z0-9\\-_]{50,}",
    "SG\\.[A-Za-z0-9_\\-]{20,}\\.[A-Za-z0-9_\\-]{20,}",
    "xox[bpoa]-[0-9A-Za-z\\-]+",
    "-----BEGIN ([A-Z ]*)?PRIVATE KEY-----",
    "eyJ[A-Za-z0-9_-]+\\.eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+",
    "AKIA[A-Z0-9]{16}",
    "AIza[0-9A-Za-z\\-_]{35}",
    "ya29\\.[0-9A-Za-z\\-_]{60,}",
].compactMap { try? NSRegularExpression(pattern: $0) }

private let sensitiveEnvKeywords = [
    "secret", "password", "passwd", "api_key", "apikey",
    "token", "auth", "private_key", "credential", "access_key",
    "client_secret", "refresh_token", "session", "cookie",
]

func isSensitive(_ content: String) -> Bool {
    let range = NSRange(content.startIndex..., in: content)
    for regex in secretPatterns {
        if regex.firstMatch(in: content, range: range) != nil { return true }
    }
    let envHits = content.components(separatedBy: "\n").filter { line in
        guard line.contains("=") else { return false }
        let parts = line.components(separatedBy: "=")
        let key = parts[0].lowercased()
        let value = parts.dropFirst().joined(separator: "=")
            .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\"'")))
        guard value.count >= 8 else { return false }
        return sensitiveEnvKeywords.contains { key.contains($0) }
    }
    return envHits.count >= 1
}

// MARK: - Content type

func detectType(_ content: String) -> String {
    let t = content.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.hasPrefix("http://") || t.hasPrefix("https://") { return "url" }
    let emailRx = try? NSRegularExpression(pattern: "^[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}$")
    if emailRx?.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) != nil { return "email" }
    let codeSignals = ["\n{", "\n}", "=>", "def ", "func ", "class ", "import ", "const ", "var "]
    if content.contains("\n"), codeSignals.contains(where: { content.contains($0) }) { return "code" }
    return "text"
}

// MARK: - Semantic search

let clipzDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".clipz")
let environment = ProcessInfo.processInfo.environment
// CLIPZ_* overrides exist so tests can run a daemon beside the real one.
let embeddingModelPath = environment["CLIPZ_MODEL"]
    ?? clipzDir.appendingPathComponent("models/embeddinggemma-2-Q8_0.gguf").path
let socketPath = environment["CLIPZ_SOCKET"] ?? clipzDir.appendingPathComponent("daemon.sock").path
let sweepInterval = TimeInterval(environment["CLIPZ_SWEEP_SECONDS"] ?? "") ?? 60
// Bump the suffix whenever the document text format changes so clips get re-embedded.
let embeddingModelKey = "embeddinggemma-2-q8_0/v1"

struct SearchHit {
    var id: Int64
    var score: Float
}

/// Runs EmbeddingGemma 2 through llama.cpp and keeps every clip vector in memory.
/// All model, DB and index access happens on `queue`, so nothing here needs locks.
final class Embedder {
    private let queue = DispatchQueue(label: "clipz.embed", qos: .userInitiated)
    private let dbPath: String
    private let log: (String) -> Void
    private var db: OpaquePointer?
    private var model: OpaquePointer?
    private var ctx: OpaquePointer?
    private var vocab: OpaquePointer?
    private var dims = 0
    // llama.cpp sizes its output buffer at n_vocab floats per input token (1 MB for Gemma's
    // 262k vocab) and never shrinks it. Capping input and recreating the context after long
    // inputs keeps the daemon near 200 MB instead of pinning gigabytes after one big clip.
    private let maxTokens: Int32 = 512
    private let longInputTokens: Int32 = 64
    private var outputBufferGrown = false
    private var loadError: String? = "Embedding model is still loading"
    private var index: [Int64: [Float]] = [:]
    private var backfillActive = false

    init(dbPath: String, log: @escaping (String) -> Void) {
        self.dbPath = dbPath
        self.log = log
    }

    func start() {
        queue.async {
            self.load()
            self.backfillActive = true
            self.backfillChunk()
        }
    }

    func requestBackfill() {
        queue.async {
            guard self.loadError == nil, !self.backfillActive else { return }
            self.backfillActive = true
            self.backfillChunk()
        }
    }

    func search(_ query: String, limit: Int) -> Result<(hits: [SearchHit], indexing: Bool, indexed: Int), Error> {
        queue.sync {
            if let error = loadError { return .failure(DaemonError(error)) }
            guard let q = embed("task: search result | query: \(query)") else {
                return .failure(DaemonError("Could not embed query"))
            }
            resetContextIfGrown()
            var hits: [SearchHit] = []
            hits.reserveCapacity(index.count)
            for (id, vector) in index {
                var score: Float = 0
                vDSP_dotpr(q, 1, vector, 1, &score, vDSP_Length(dims))
                hits.append(SearchHit(id: id, score: score))
            }
            hits.sort { $0.score > $1.score }
            return .success((Array(relevant(hits).prefix(limit)), backfillActive, index.count))
        }
    }

    /// EmbeddingGemma scores unrelated clips around 0.55–0.65 and real matches only a little
    /// higher, so a fixed cutoff doesn't work. Keep hits that stand out from this query's own
    /// score distribution and sit close to the best match.
    private func relevant(_ sorted: [SearchHit]) -> [SearchHit] {
        guard let top = sorted.first?.score else { return [] }
        let floor: Float = 0.63
        guard sorted.count >= 30 else { return sorted.filter { $0.score >= max(floor, 0.66) } }

        let scores = sorted.map(\.score)
        var mean: Float = 0
        var deviation: Float = 0
        vDSP_normalize(scores, 1, nil, 1, &mean, &deviation, vDSP_Length(scores.count))
        guard deviation > 0 else { return [] }
        return sorted.filter {
            $0.score >= floor && $0.score >= top - 0.08 && ($0.score - mean) / deviation >= 2
        }
    }

    // MARK: Model

    private func load() {
        guard FileManager.default.fileExists(atPath: embeddingModelPath) else {
            loadError = "Embedding model missing. Run daemon/install.sh"
            log("⚠️  \(loadError!) (\(embeddingModelPath))")
            return
        }
        llama_log_set({ level, text, _ in
            if level.rawValue >= GGML_LOG_LEVEL_ERROR.rawValue, let text { fputs(String(cString: text), stderr) }
        }, nil)
        llama_backend_init()

        var modelParams = llama_model_default_params()
        modelParams.progress_callback = { _, _ in true } // silences the loading dots
        guard let model = llama_model_load_from_file(embeddingModelPath, modelParams) else {
            loadError = "Could not load embedding model"
            log("⚠️  \(loadError!)")
            return
        }
        self.model = model
        guard let ctx = makeContext() else {
            loadError = "Could not create embedding context"
            log("⚠️  \(loadError!)")
            return
        }
        self.ctx = ctx
        vocab = llama_model_get_vocab(model)
        dims = Int(llama_model_n_embd_out(model))

        guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else {
            loadError = "Could not open database for embeddings"
            log("⚠️  \(loadError!)")
            return
        }
        sqlite3_busy_timeout(db, 5000)
        loadIndex()
        loadError = nil
        log("🧠 EmbeddingGemma 2 ready · \(dims)d · \(index.count) clips indexed")
    }

    private func makeContext() -> OpaquePointer? {
        var params = llama_context_default_params()
        params.embeddings = true
        // Non-causal embedding models need the whole input in one micro-batch.
        params.n_ctx = UInt32(maxTokens)
        params.n_batch = UInt32(maxTokens)
        params.n_ubatch = UInt32(maxTokens)
        return llama_init_from_model(model, params)
    }

    private func resetContextIfGrown() {
        guard outputBufferGrown, let old = ctx else { return }
        llama_free(old)
        ctx = makeContext()
        outputBufferGrown = false
        if ctx == nil {
            loadError = "Could not recreate embedding context"
            log("⚠️  \(loadError!)")
        }
    }

    /// Returns an L2-normalised embedding, or nil if the text produced no tokens.
    private func embed(_ text: String) -> [Float]? {
        guard let ctx, let vocab, dims > 0 else { return nil }
        // Only the first maxTokens matter. 4k characters always covers them and stays well
        // under the token buffer even if every byte became its own token.
        let clipped = text.count > 4_000 ? String(text.prefix(4_000)) : text
        let utf8 = Array(clipped.utf8)
        var tokens = [llama_token](repeating: 0, count: 16_384)
        var count = utf8.withUnsafeBufferPointer { buf in
            buf.withMemoryRebound(to: CChar.self) {
                llama_tokenize(vocab, $0.baseAddress, Int32(buf.count), &tokens, Int32(tokens.count), true, true)
            }
        }
        if count < 0 { return nil }
        count = min(count, maxTokens)
        guard count > 0 else { return nil }
        if count > longInputTokens { outputBufferGrown = true }

        llama_memory_clear(llama_get_memory(ctx), true)
        var batch = llama_batch_init(count, 0, 1)
        defer { llama_batch_free(batch) }
        for i in 0..<Int(count) {
            batch.token[i] = tokens[i]
            batch.pos[i] = Int32(i)
            batch.n_seq_id[i] = 1
            batch.seq_id[i]![0] = 0
            batch.logits[i] = 1
        }
        batch.n_tokens = count
        guard llama_decode(ctx, batch) == 0, let out = llama_get_embeddings_seq(ctx, 0) else { return nil }

        var vector = Array(UnsafeBufferPointer(start: out, count: dims))
        var norm: Float = 0
        vDSP_svesq(vector, 1, &norm, vDSP_Length(dims))
        norm = sqrt(norm)
        guard norm > 0 else { return nil }
        vDSP_vsdiv(vector, 1, &norm, &vector, 1, vDSP_Length(dims))
        return vector
    }

    private func documentText(content: String, app: String?, url: String?, file: String?) -> String {
        var title: [String] = []
        if let app, !app.isEmpty { title.append(app) }
        if let url, let host = URL(string: url)?.host { title.append(host) }
        if let file, !file.isEmpty { title.append((file as NSString).lastPathComponent) }
        return "title: \(title.isEmpty ? "none" : title.joined(separator: " · ")) | text: \(content)"
    }

    // MARK: Index

    private func loadIndex() {
        index.removeAll(keepingCapacity: true)
        let sql = "SELECT clip_id, embedding FROM clip_embeddings WHERE model = ?"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, embeddingModelKey, -1, SQLITE_TRANSIENT)
        while sqlite3_step(stmt) == SQLITE_ROW {
            let bytes = Int(sqlite3_column_bytes(stmt, 1))
            guard bytes == dims * MemoryLayout<Float>.size, let blob = sqlite3_column_blob(stmt, 1) else { continue }
            index[sqlite3_column_int64(stmt, 0)] = Array(UnsafeBufferPointer(
                start: blob.assumingMemoryBound(to: Float.self), count: dims))
        }
    }

    private func storedVectorCount() -> Int {
        let sql = "SELECT count(*) FROM clip_embeddings WHERE model = ? AND length(embedding) = ?"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return index.count }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, embeddingModelKey, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int(stmt, 2, Int32(dims * MemoryLayout<Float>.size))
        return sqlite3_step(stmt) == SQLITE_ROW ? Int(sqlite3_column_int64(stmt, 0)) : index.count
    }

    /// Embeds a few missing clips, then re-queues itself so searches can run in between.
    private func backfillChunk() {
        guard loadError == nil else { backfillActive = false; return }
        // Another Mac (via iCloud) or a deleted clip can change the table under us.
        if storedVectorCount() != index.count { loadIndex() }

        let sql = """
        SELECT c.id, c.content_hash, c.content, c.source_app, c.source_url, c.source_file
        FROM clips c
        LEFT JOIN clip_embeddings e
          ON e.clip_id = c.id AND e.model = ?1 AND e.content_hash = c.content_hash
        WHERE c.is_sensitive = 0 AND e.clip_id IS NULL
        ORDER BY c.created_at DESC
        LIMIT 8
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { backfillActive = false; return }
        sqlite3_bind_text(stmt, 1, embeddingModelKey, -1, SQLITE_TRANSIENT)
        var pending: [(id: Int64, hash: String, text: String)] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let column = { (i: Int32) -> String? in sqlite3_column_text(stmt, i).map { String(cString: $0) } }
            pending.append((
                sqlite3_column_int64(stmt, 0),
                column(1) ?? "",
                documentText(content: column(2) ?? "", app: column(3), url: column(4), file: column(5))
            ))
        }
        sqlite3_finalize(stmt)

        guard !pending.isEmpty else { backfillActive = false; return }
        for clip in pending {
            let vector = embed(clip.text)
            // An empty blob marks a clip we couldn't embed, so it isn't retried forever.
            save(id: clip.id, hash: clip.hash, vector: vector ?? [])
            index[clip.id] = vector
        }
        resetContextIfGrown()
        queue.async { self.backfillChunk() }
    }

    private func save(id: Int64, hash: String, vector: [Float]) {
        let sql = """
        INSERT OR REPLACE INTO clip_embeddings (clip_id, content_hash, model, embedding, created_at)
        VALUES (?, ?, ?, ?, unixepoch())
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int64(stmt, 1, id)
        sqlite3_bind_text(stmt, 2, hash, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 3, embeddingModelKey, -1, SQLITE_TRANSIENT)
        vector.withUnsafeBytes { raw in
            _ = sqlite3_bind_blob(stmt, 4, raw.baseAddress ?? UnsafeRawPointer(bitPattern: 1), Int32(raw.count), SQLITE_TRANSIENT)
        }
        sqlite3_step(stmt)
    }
}

struct DaemonError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

// MARK: - Local socket

/// Line-delimited JSON over a user-only Unix socket: one request line in, one response line out.
final class SocketServer {
    private let path: String
    private let handler: ([String: Any]) -> [String: Any]

    init(path: String, handler: @escaping ([String: Any]) -> [String: Any]) {
        self.path = path
        self.handler = handler
    }

    func start(log: (String) -> Void) {
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { log("⚠️  Could not create socket"); return }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        guard path.utf8.count < maxLen else { log("⚠️  Socket path too long"); return }
        withUnsafeMutablePointer(to: &addr.sun_path) {
            $0.withMemoryRebound(to: CChar.self, capacity: maxLen) { _ = strlcpy($0, path, maxLen) }
        }

        let oldMask = umask(0o077)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        umask(oldMask)
        guard bound == 0, listen(fd, 16) == 0 else {
            log("⚠️  Could not listen on \(path): \(String(cString: strerror(errno)))")
            close(fd)
            return
        }

        let thread = Thread { [self] in
            while true {
                let client = accept(fd, nil, nil)
                if client < 0 { continue }
                DispatchQueue.global(qos: .userInitiated).async { self.serve(client) }
            }
        }
        thread.name = "clipz.socket"
        thread.start()
        log("🔌 Listening on \(path)")
    }

    private func serve(_ client: Int32) {
        defer { close(client) }
        var on: Int32 = 1
        setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        var timeout = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

        var request = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while request.count < 65_536, !request.contains(0x0A) {
            let n = read(client, &buffer, buffer.count)
            if n <= 0 { break }
            request.append(contentsOf: buffer[0..<n])
        }
        let line = request.split(separator: 0x0A, maxSplits: 1, omittingEmptySubsequences: false).first ?? Data()
        let response: [String: Any]
        if let json = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] {
            response = handler(json)
        } else {
            response = ["ok": false, "error": "Invalid request"]
        }
        guard var out = try? JSONSerialization.data(withJSONObject: response) else { return }
        out.append(0x0A)
        out.withUnsafeBytes { raw in
            var sent = 0
            while sent < raw.count {
                let n = write(client, raw.baseAddress! + sent, raw.count - sent)
                if n <= 0 { break }
                sent += n
            }
        }
    }
}

// MARK: - Daemon

final class ClipzDaemon {
    private let db: DB
    private let embedder: Embedder
    private var server: SocketServer?
    private var lastChangeCount = -1

    init() {
        let location = resolveDatabaseLocation()
        db = DB(path: location.path, syncsAcrossDevices: location.syncsAcrossDevices)
        embedder = Embedder(dbPath: location.path, log: { msg in
            print("[\(ISO8601DateFormatter().string(from: Date()))] \(msg)")
            fflush(stdout)
        })
        log("Clipz daemon started · \(location.syncsAcrossDevices ? "iCloud Drive" : "local") · \(location.path)")
    }

    private func handle(_ request: [String: Any]) -> [String: Any] {
        switch request["op"] as? String {
        case "search":
            guard let query = request["query"] as? String,
                  !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return ["ok": false, "error": "Missing query"]
            }
            let limit = min(max(request["limit"] as? Int ?? 40, 1), 200)
            switch embedder.search(query, limit: limit) {
            case .success(let result):
                return [
                    "ok": true,
                    "results": result.hits.map { ["id": $0.id, "score": Double($0.score)] },
                    "indexing": result.indexing,
                    "indexed": result.indexed,
                ]
            case .failure(let error):
                return ["ok": false, "error": error.localizedDescription]
            }
        default:
            return ["ok": false, "error": "Unknown op"]
        }
    }

    private func log(_ msg: String) {
        print("[\(ISO8601DateFormatter().string(from: Date()))] \(msg)")
        fflush(stdout)
    }

    func tick() {
        let pb = NSPasteboard.general
        guard pb.changeCount != lastChangeCount else { return }
        lastChangeCount = pb.changeCount

        let types = pb.types ?? []
        for blocked in ["org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType",
                        "org.nspasteboard.AutoFilteredType"] {
            if types.contains(NSPasteboard.PasteboardType(blocked)) {
                log("Skipped protected item"); return
            }
        }

        guard let content = pb.string(forType: .string),
              !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }

        let app       = NSWorkspace.shared.frontmostApplication?.localizedName
        let hash      = fastHash(content)
        let sensitive = isSensitive(content)
        let kind      = sensitive ? "sensitive" : detectType(content)
        let context   = app.map { getSourceContext(for: $0) } ?? SourceContext()

        // Capture rich HTML (capped at 200 KB)
        let rawHtml = pb.data(forType: NSPasteboard.PasteboardType("public.html"))
            .flatMap { String(data: $0, encoding: .utf8) }
        let html: String? = rawHtml.map { h in
            h.count > 200_000 ? String(h.prefix(200_000)) : h
        }

        // Language: VS Code/Cursor stores editor metadata on the pasteboard
        var lang: String? = nil
        if let vsData = pb.string(forType: NSPasteboard.PasteboardType("vscode-editor-data")),
           let data = vsData.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let mode = json["mode"] as? String, !mode.isEmpty {
            lang = mode
        }
        // Fallback: extract language class from HTML (GitHub, Notion, web IDEs)
        if lang == nil, let h = html {
            let patterns = ["class=[\"']language-([a-zA-Z0-9+#-]+)[\"']",
                            "data-lang=[\"']([a-zA-Z0-9+#-]+)[\"']"]
            for pat in patterns {
                if let rx = try? NSRegularExpression(pattern: pat),
                   let m = rx.firstMatch(in: h, range: NSRange(h.startIndex..., in: h)),
                   let r = Range(m.range(at: 1), in: h) {
                    lang = String(h[r])
                    break
                }
            }
        }

        db.insert(
            content:   content,
            hash:      hash,
            type:      kind,
            sensitive: sensitive,
            app:       app,
            url:       context.url,
            file:      context.file,
            html:      sensitive ? nil : html,
            lang:      lang
        )

        if !sensitive { embedder.requestBackfill() }

        let preview = content.prefix(70).replacingOccurrences(of: "\n", with: " ")
        let ctx = [context.url, context.file].compactMap { $0 }.first.map { " · \($0.prefix(60))" } ?? ""
        log("\(sensitive ? "🔒" : "📋") [\(kind)] \"\(preview)\"\(ctx) — \(app ?? "?")")
    }

    func run() {
        lastChangeCount = NSPasteboard.general.changeCount
        embedder.start()
        let server = SocketServer(path: socketPath) { [weak self] in
            self?.handle($0) ?? ["ok": false, "error": "Daemon shutting down"]
        }
        server.start(log: log)
        self.server = server
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.tick() }
        // Picks up clips synced from other Macs and anything a failed pass left behind.
        Timer.scheduledTimer(withTimeInterval: sweepInterval, repeats: true) { [weak self] _ in self?.embedder.requestBackfill() }
        RunLoop.main.run()
    }
}

let daemon = ClipzDaemon()
daemon.run()
