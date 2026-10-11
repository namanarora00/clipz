// End-to-end tests for the clipz daemon's semantic search.
//
// Runs the built daemon (bash daemon/build.sh) against a throwaway database and socket,
// so it never touches your real history or a running daemon. Needs the model from
// daemon/install.sh. Set CLIPZ_TEST_PASTEBOARD=1 to also test live clipboard capture
// (it copies a test string and then restores your text clipboard).

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const BIN =
  process.env.CLIPZ_DAEMON_BIN ?? join(homedir(), ".clipz", "clipz-daemon");
const MODEL_KEY = "embeddinggemma-2-q8_0/v1";

// Invented clips. `expect` names the query each one should win.
const FIXTURES = [
  {
    key: "flight",
    content:
      "Boarding pass: IndiGo 6E 2134 BLR to DEL, seat 14C, gate 22, departs 07:15",
    app: "Mail",
  },
  {
    key: "email1",
    content: "priya.sharma@example.com",
    type: "email",
    app: "Google Chrome",
  },
  {
    key: "email2",
    content: "billing@acme-corp.io",
    type: "email",
    app: "Slack",
  },
  {
    key: "github",
    content: "https://github.com/ggml-org/llama.cpp",
    type: "url",
    app: "Arc",
    url: "https://github.com/ggml-org/llama.cpp",
  },
  {
    key: "sql",
    content:
      "SELECT user_id, count(*) FROM orders\nWHERE created_at > now() - interval '7 days'\nGROUP BY 1 ORDER BY 2 DESC;",
    type: "code",
    app: "TablePlus",
  },
  {
    key: "groceries",
    content: "milk, eggs, sourdough, spinach, oat milk, coffee beans, bananas",
    app: "Notes",
  },
  {
    key: "recipe",
    content:
      "Preheat the oven to 200°C. Toss the potatoes with olive oil, rosemary and salt, then roast for 40 minutes.",
    app: "Safari",
  },
  {
    key: "swift",
    content:
      "func fetchUser(id: Int) async throws -> User {\n    let (data, _) = try await URLSession.shared.data(from: endpoint(id))\n    return try JSONDecoder().decode(User.self, from: data)\n}",
    type: "code",
    app: "Xcode",
    file: "/Users/test/App/UserService.swift",
  },
  {
    key: "docker",
    content: "docker compose up -d --build api worker",
    app: "Terminal",
  },
  {
    key: "meeting",
    content:
      "Standup moved to 10:30 tomorrow, the Zoom link is in the calendar invite",
    app: "Slack",
  },
  {
    key: "address",
    content: "221B Baker Street, London NW1 6XE, United Kingdom",
    app: "Maps",
  },
  {
    key: "tracking",
    content:
      "Your package 1Z999AA10123456784 is out for delivery and should arrive by 8pm",
    app: "Mail",
  },
  {
    key: "hindi",
    content: "नमस्ते! कल सुबह दस बजे मिलते हैं",
    app: "WhatsApp",
  },
  {
    key: "emoji",
    content: "🎉🎉 shipped the release, drinks on me 🍻",
    app: "Slack",
  },
  {
    key: "secret",
    content: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    type: "sensitive",
    sensitive: true,
    app: "Terminal",
  },
  {
    key: "huge",
    content: "Quarterly planning notes. ".repeat(8000),
    app: "Notes",
  },
  // Filler so the score distribution looks like a real history.
  ...[
    "ok sounds good",
    "lol",
    "https://news.ycombinator.com/item?id=4100000",
    "#ff6b6b",
    "npm install --save-dev typescript",
    "thanks!",
    "Can you send the deck before Friday?",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "rgba(0, 0, 0, 0.5)",
    "lorem ipsum dolor sit amet",
    "The mitochondria is the powerhouse of the cell",
    "brb 5 min",
    "git rebase -i HEAD~3",
    "https://en.wikipedia.org/wiki/Alan_Turing",
    "Invoice #4821 — due 30 Nov",
    "0.1 + 0.2 = 0.30000000000000004",
    "Happy birthday Mom ❤️",
    "kubectl get pods -n staging",
    "Wifi password is on the fridge",
    "Remember to water the plants",
    "border-radius: 12px;",
    "Chapter 3: The Long Walk Home",
    "https://www.figma.com/file/abc123/Onboarding",
    "SELECT 1",
    "yes",
    "Meeting notes: hiring plan Q1",
    "pip install numpy pandas",
    "Taxi receipt ₹420",
    "The quick brown fox jumps over the lazy dog",
  ].map((content, i) => ({ key: `filler${i}`, content, app: "Notes" })),
];

const QUALITY = [
  ["flight booking", "flight"],
  ["github repo", "github"],
  ["sql query for recent orders", "sql"],
  ["shopping list", "groceries"],
  ["how to roast potatoes", "recipe"],
  ["swift networking code", "swift"],
  ["docker command", "docker"],
  ["when is standup", "meeting"],
  ["street address in london", "address"],
  ["package delivery tracking number", "tracking"],
  ["hindi message about meeting tomorrow", "hindi"],
  ["celebration party", "emoji"],
];

let dir,
  dbPath,
  socketPath,
  daemon,
  log = "";
const ids = new Map();

function sqlite(sql) {
  const out = spawnSync("/usr/bin/sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
  });
  if (out.status !== 0) throw new Error(out.stderr);
  return out.stdout.trim() ? JSON.parse(out.stdout) : [];
}
const q = (s) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);

function insertClip(f) {
  const hash = `test-${f.key}-${Math.random().toString(16).slice(2)}`;
  const [row] = sqlite(`
    INSERT INTO clips (content, content_hash, content_type, is_sensitive, source_app, source_url, source_file)
    VALUES (${q(f.content)}, ${q(hash)}, ${q(f.type ?? "text")}, ${f.sensitive ? 1 : 0}, ${q(f.app)}, ${q(f.url)}, ${q(f.file)})
    RETURNING id`);
  ids.set(f.key, row.id);
  return row.id;
}

const embeddedCount = () =>
  sqlite(
    `SELECT count(*) AS n FROM clip_embeddings WHERE model = ${q(MODEL_KEY)}`,
  )[0].n;

function raw(payload, path = socketPath) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buf = "";
    socket.setTimeout(15_000, () => {
      socket.destroy();
      reject(new Error("timeout"));
    });
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) {
        socket.end();
        resolve(JSON.parse(buf.slice(0, buf.indexOf("\n"))));
      }
    });
    socket.on("error", reject);
  });
}
const search = (query, extra = {}) =>
  raw(`${JSON.stringify({ op: "search", query, ...extra })}\n`);
const keyOf = (id) => [...ids].find(([, v]) => v === id)?.[0];

async function waitFor(check, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${label}\n--- daemon log ---\n${log}`);
}

function startDaemon(env = {}) {
  log = "";
  const child = spawn(BIN, [], {
    env: {
      ...process.env,
      CLIPZ_DB: dbPath,
      CLIPZ_SOCKET: socketPath,
      CLIPZ_SWEEP_SECONDS: "1",
      ...env,
    },
  });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  return child;
}

async function stopDaemon(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await exited;
}

function footprintMB(pid) {
  const out = spawnSync("/usr/bin/footprint", ["-p", String(pid)], {
    encoding: "utf8",
  }).stdout;
  const m = out.match(/phys_footprint:\s+([\d.]+)\s*(KB|MB|GB)/);
  if (!m) return NaN;
  return Number(m[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[m[2]];
}

before(async () => {
  assert.ok(
    existsSync(BIN),
    `Daemon binary missing at ${BIN}. Run: bash daemon/build.sh`,
  );
  dir = mkdtempSync(join(tmpdir(), "clipz-test-"));
  dbPath = join(dir, "history.db");
  socketPath = join(dir, "daemon.sock");

  daemon = startDaemon();
  await waitFor(
    () => log.includes("EmbeddingGemma 2 ready"),
    60_000,
    "model to load",
  );
  for (const f of FIXTURES) insertClip(f);
  // The sweep (1s in tests) should embed everything except the sensitive clip.
  await waitFor(
    () => embeddedCount() === FIXTURES.length - 1,
    120_000,
    "backfill",
  );
});

after(async () => {
  await stopDaemon(daemon);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("indexing", () => {
  test("embeds every non-sensitive clip as a 768-dim float32 vector", () => {
    const rows = sqlite(
      `SELECT clip_id, length(embedding) AS bytes FROM clip_embeddings WHERE model = ${q(MODEL_KEY)}`,
    );
    assert.equal(rows.length, FIXTURES.length - 1);
    for (const row of rows)
      assert.equal(
        row.bytes,
        768 * 4,
        `clip ${keyOf(row.clip_id)} has ${row.bytes} bytes`,
      );
  });

  test("never embeds sensitive clips", () => {
    const rows = sqlite(
      `SELECT * FROM clip_embeddings WHERE clip_id = ${ids.get("secret")}`,
    );
    assert.equal(rows.length, 0);
  });

  test("socket is only accessible to the current user", () => {
    assert.equal(
      statSync(socketPath).mode & 0o077,
      0,
      "group/other must have no access",
    );
  });
});

describe("search quality", () => {
  for (const [query, expected] of QUALITY) {
    test(`"${query}" ranks the ${expected} clip first`, async () => {
      const res = await search(query);
      assert.equal(res.ok, true, res.error);
      const got = res.results.map((r) => keyOf(r.id));
      assert.equal(got[0], expected, `got [${got.join(", ")}]`);
    });
  }

  test("both emails come back for 'email address'", async () => {
    const res = await search("email address");
    const got = res.results.map((r) => keyOf(r.id));
    assert.deepEqual(
      new Set(got.slice(0, 2)),
      new Set(["email1", "email2"]),
      `got [${got.join(", ")}]`,
    );
  });

  test("an unrelated query returns little or nothing", async () => {
    const res = await search(
      "quantum chromodynamics lecture on gluon confinement",
    );
    assert.ok(
      res.results.length <= 2,
      `got ${res.results.map((r) => keyOf(r.id)).join(", ")}`,
    );
  });

  test("never returns the sensitive clip, even when asked for it", async () => {
    const res = await search("aws secret access key");
    assert.ok(!res.results.some((r) => r.id === ids.get("secret")));
  });

  test("scores are sorted and within cosine range", async () => {
    const { results } = await search("notes");
    for (let i = 1; i < results.length; i++)
      assert.ok(results[i - 1].score >= results[i].score);
    for (const r of results) assert.ok(r.score > 0 && r.score <= 1.0001);
  });
});

describe("index updates", () => {
  test("a new clip becomes searchable without a restart", async () => {
    const id = insertClip({
      key: "newclip",
      content: "Dentist appointment on Thursday at 4:30pm with Dr. Mehta",
      app: "Calendar",
    });
    await waitFor(
      async () => (await search("dentist appointment")).results[0]?.id === id,
      15_000,
      "new clip in results",
    );
  });

  test("a deleted clip disappears from results and its vector is removed", async () => {
    const id = ids.get("docker");
    sqlite(`DELETE FROM clips WHERE id = ${id}`);
    assert.equal(
      sqlite(`SELECT * FROM clip_embeddings WHERE clip_id = ${id}`).length,
      0,
    );
    await waitFor(
      async () =>
        !(await search("docker command")).results.some((r) => r.id === id),
      15_000,
      "deleted clip to drop out",
    );
  });
});

describe("protocol", () => {
  test("rejects malformed JSON", async () => {
    assert.deepEqual(await raw("{nope\n"), {
      ok: false,
      error: "Invalid request",
    });
  });

  test("rejects unknown ops and empty queries", async () => {
    assert.equal((await raw('{"op":"drop tables"}\n')).ok, false);
    assert.equal((await search("   ")).ok, false);
    assert.equal((await raw('{"op":"search"}\n')).ok, false);
  });

  test("clamps the limit", async () => {
    const one = await search("notes", { limit: 0 });
    assert.ok(one.ok && one.results.length <= 1);
    const many = await search("notes", { limit: 100000 });
    assert.ok(many.ok && many.results.length <= 200);
  });

  test("handles 50 concurrent searches", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        search(i % 2 ? "flight booking" : "shopping list"),
      ),
    );
    for (const [i, r] of results.entries()) {
      assert.equal(r.ok, true);
      assert.equal(keyOf(r.results[0].id), i % 2 ? "flight" : "groceries");
    }
  });

  test("a very long query works and memory stays bounded", async () => {
    const res = await search("tell me about flights ".repeat(2000));
    assert.equal(res.ok, true);
    const mb = footprintMB(daemon.pid);
    assert.ok(mb < 400, `daemon footprint ${mb} MB after long inputs`);
  });

  test("answers searches in well under 100ms", async () => {
    const start = performance.now();
    for (let i = 0; i < 10; i++) await search("github repo");
    const avg = (performance.now() - start) / 10;
    assert.ok(avg < 100, `average ${avg.toFixed(1)}ms`);
  });
});

describe("lifecycle", () => {
  test("restarts over a stale socket and reloads the index without re-embedding", async () => {
    const before = embeddedCount();
    const lastEmbedded = sqlite(
      `SELECT max(created_at) AS t FROM clip_embeddings`,
    )[0].t;
    daemon.kill("SIGKILL");
    await new Promise((r) => daemon.once("exit", r));
    assert.ok(existsSync(socketPath), "expected a stale socket after SIGKILL");

    daemon = startDaemon();
    await waitFor(
      () => log.includes("EmbeddingGemma 2 ready"),
      60_000,
      "restart",
    );
    assert.match(log, new RegExp(`${before} clips indexed`));
    const res = await search("flight booking");
    assert.equal(keyOf(res.results[0].id), "flight");
    assert.equal(
      sqlite(`SELECT max(created_at) AS t FROM clip_embeddings`)[0].t,
      lastEmbedded,
    );
  });

  test("reports a missing model instead of crashing", async () => {
    const otherSocket = join(dir, "missing.sock");
    const child = startDaemon({
      CLIPZ_MODEL: join(dir, "nope.gguf"),
      CLIPZ_SOCKET: otherSocket,
    });
    try {
      await waitFor(
        () => existsSync(otherSocket) && log.includes("model missing"),
        15_000,
        "missing-model log",
      );
      const res = await raw(
        `${JSON.stringify({ op: "search", query: "x" })}\n`,
        otherSocket,
      );
      assert.deepEqual(res, {
        ok: false,
        error: "Embedding model missing. Run daemon/install.sh",
      });
    } finally {
      await stopDaemon(child);
    }
  });
});

describe("TypeScript client", () => {
  let client;
  before(async () => {
    // Compile the real Raycast-side module so this exercises exactly what ships.
    const out = join(dir, "ts");
    const tsc = spawnSync(
      "npx",
      [
        "tsc",
        "src/semantic-search.ts",
        "--outDir",
        out,
        "--module",
        "commonjs",
        "--target",
        "es2022",
        "--strict",
        "--skipLibCheck",
        "--types",
        "node",
      ],
      { encoding: "utf8" },
    );
    assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
    process.env.CLIPZ_SOCKET = socketPath;
    client = (await import(join(out, "semantic-search.js"))).default;
  });

  test("returns full clips in rank order", async () => {
    const results = await client.semanticSearch(dbPath, "flight booking");
    assert.equal(results[0].clip.id, ids.get("flight"));
    assert.equal(results[0].clip.source_app, "Mail");
    assert.match(results[0].clip.content, /Boarding pass/);
  });

  test("explains when the daemon isn't running", async () => {
    process.env.CLIPZ_SOCKET = join(dir, "nobody-home.sock");
    try {
      await assert.rejects(
        client.semanticSearch(dbPath, "anything"),
        /daemon isn't running/,
      );
    } finally {
      process.env.CLIPZ_SOCKET = socketPath;
    }
  });
});

describe(
  "live clipboard",
  {
    skip:
      process.env.CLIPZ_TEST_PASTEBOARD !== "1" &&
      "set CLIPZ_TEST_PASTEBOARD=1",
  },
  () => {
    test("a copied clip is captured, embedded and searchable within seconds", async () => {
      // Start a daemon whose sweep is slow, so only the on-copy path can embed in time.
      await stopDaemon(daemon);
      daemon = startDaemon({ CLIPZ_SWEEP_SECONDS: "3600" });
      await waitFor(
        () => log.includes("EmbeddingGemma 2 ready"),
        60_000,
        "restart",
      );

      const saved = spawnSync("pbpaste", { encoding: "utf8" }).stdout;
      const marker = `Clipz live test ${Date.now()}: renew the passport at the consulate`;
      try {
        spawnSync("pbcopy", { input: marker });
        await waitFor(
          () =>
            sqlite(`SELECT id FROM clips WHERE content = ${q(marker)}`)
              .length === 1,
          10_000,
          "capture",
        );
        const [{ id }] = sqlite(
          `SELECT id FROM clips WHERE content = ${q(marker)}`,
        );
        await waitFor(
          async () => (await search("passport renewal")).results[0]?.id === id,
          10_000,
          "on-copy embedding",
        );
      } finally {
        spawnSync("pbcopy", { input: saved });
      }
    });
  },
);
