import Foundation
import AppKit
import SQLite3

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

// MARK: - Daemon

final class ClipzDaemon {
    private let db: DB
    private var lastChangeCount = -1

    init() {
        let location = resolveDatabaseLocation()
        db = DB(path: location.path, syncsAcrossDevices: location.syncsAcrossDevices)
        log("Clipz daemon started · \(location.syncsAcrossDevices ? "iCloud Drive" : "local") · \(location.path)")
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

        let preview = content.prefix(70).replacingOccurrences(of: "\n", with: " ")
        let ctx = [context.url, context.file].compactMap { $0 }.first.map { " · \($0.prefix(60))" } ?? ""
        log("\(sensitive ? "🔒" : "📋") [\(kind)] \"\(preview)\"\(ctx) — \(app ?? "?")")
    }

    func run() {
        lastChangeCount = NSPasteboard.general.changeCount
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.run()
    }
}

let daemon = ClipzDaemon()
daemon.run()
