import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  Clipboard,
  getPreferenceValues,
  showHUD,
  open,
  AI,
  environment,
} from "@raycast/api";
import { runAppleScript, useSQL } from "@raycast/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { Clip, DB_PATH } from "./db";
import {
  buildDetailMarkdown,
  clipListIcon,
  detectHexColor,
  detectSecretType,
  hexToHsl,
  hexToRgb,
  isShellCommand,
  maskSensitiveContent,
  relativeTime,
  truncate,
} from "./utils";

interface Prefs {
  aiMode: "ollama" | "openai" | "anthropic" | "raycast" | "none";
  ollamaUrl: string;
  ollamaModel: string;
  apiKey: string;
  apiModel: string;
}

interface SearchStrategy {
  since?: number;
  until?: number;
  source_app?: string;
  content_type?: string;
  is_sensitive?: boolean;
  search_terms?: string;
}

// ── AI backends ───────────────────────────────────────────────────────────────

async function ollamaGenerate(
  prompt: string,
  url: string,
  model: string,
): Promise<string> {
  const res = await fetch(`${url}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0.1 },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  return ((await res.json()) as { response: string }).response;
}

async function openaiGenerate(
  prompt: string,
  key: string,
  model: string,
): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
  return ((await res.json()) as { choices: { message: { content: string } }[] })
    .choices[0].message.content;
}

async function anthropicGenerate(
  prompt: string,
  key: string,
  model: string,
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);
  return ((await res.json()) as { content: { text: string }[] }).content[0]
    .text;
}

async function raycastGenerate(prompt: string): Promise<string> {
  if (!environment.canAccess(AI))
    throw new Error("Raycast AI requires Raycast Pro");
  return AI.ask(prompt, { creativity: "none" });
}

function generate(prompt: string, prefs: Prefs): Promise<string> {
  if (prefs.aiMode === "openai")
    return openaiGenerate(
      prompt,
      prefs.apiKey,
      prefs.apiModel || "gpt-4o-mini",
    );
  if (prefs.aiMode === "anthropic")
    return anthropicGenerate(
      prompt,
      prefs.apiKey,
      prefs.apiModel || "claude-haiku-4-5-20251001",
    );
  if (prefs.aiMode === "raycast") return raycastGenerate(prompt);
  return ollamaGenerate(prompt, prefs.ollamaUrl, prefs.ollamaModel);
}

// ── Pass 1: query planning ────────────────────────────────────────────────────

const NOW = Math.floor(Date.now() / 1000);
const SOD = NOW - (NOW % 86400); // start of today

function defaultStrategies(): SearchStrategy[] {
  return [
    {}, // full scan, sorted by recency
    { since: SOD }, // today
    { since: SOD - 7 * 86400 }, // this week
    { content_type: "url" }, // all URLs
  ];
}

async function planQuery(
  question: string,
  prefs: Prefs,
): Promise<SearchStrategy[]> {
  const now = Math.floor(Date.now() / 1000);
  const sod = now - (now % 86400);

  const prompt = `You are a clipboard search planner. Given a question, generate 4–6 lenient SQLite search strategies to retrieve relevant clipboard items. Be BROAD — it's better to over-fetch than miss items.

Current unix timestamp: ${now}
Today starts at: ${sod}
One week ago: ${sod - 7 * 86400}
One month ago: ${sod - 30 * 86400}

Each strategy is a JSON object with optional fields:
- "since": unix timestamp (items created after this time)
- "until": unix timestamp (items created before this time)
- "source_app": app name substring to match (e.g. "Chrome", "Cursor", "Slack")
- "content_type": one of "url", "code", "email", "text", "sensitive"
- "search_terms": a short keyword or phrase to LIKE-match in content (be lenient, use core noun not full phrase)

Rules:
- Always include a broad fallback strategy like {} or {"since": <one week ago>}
- For broad website/page/link questions like "what websites was I looking at", "what site was that", or misspellings like "wesbite": include {"content_type":"url"}, include a broad Chrome/browser strategy, and avoid narrow search_terms unless the user names a specific domain/topic
- For specific website/URL queries with a named topic/domain: include {"content_type":"url"} and a terms strategy with the domain/site/topic name
- If the user asks "what was I looking at / using / copying" without a specific keyword, do not over-constrain. Use broad recency/app/content-type strategies
- For code queries: include {"content_type":"code"} and a terms strategy
- For "today"/"this week" queries: use since timestamps
- For app-specific queries: include source_app
- "I went to X" = look for URLs containing X
- Overlap is fine — UNION will deduplicate
- Err on the side of fewer search_terms constraints (a missing item is worse than an extra one)

Return ONLY a JSON array. No explanation. No markdown fences.

Question: ${question}

Example output:
[
  {"content_type":"url","search_terms":"github"},
  {"source_app":"Chrome","since":${sod - 7 * 86400}},
  {"search_terms":"github"},
  {"since":${sod - 30 * 86400},"content_type":"url"},
  {}
]`;

  try {
    const raw = await generate(prompt, prefs);
    const stripped = raw
      .replace(/```(?:json)?/gi, "")
      .replace(/```/g, "")
      .trim();
    const match = stripped.match(/\[[\s\S]*\]/);
    if (!match) return defaultStrategies();
    const parsed = JSON.parse(match[0]) as SearchStrategy[];
    if (!Array.isArray(parsed) || parsed.length === 0)
      return defaultStrategies();
    // Always append a broad fallback so we never get zero results
    if (
      !parsed.some(
        (s) => !s.since && !s.source_app && !s.search_terms && !s.content_type,
      )
    ) {
      parsed.push({});
    }
    return parsed.slice(0, 7);
  } catch {
    return defaultStrategies();
  }
}

// ── Pass 1.5: build UNION SQL ─────────────────────────────────────────────────

const COLS =
  "id,content,content_type,is_sensitive,source_app,source_url,source_file,content_html,content_lang,created_at,copy_count";

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

function strategyToSQL(s: SearchStrategy): string {
  const conds: string[] = [];
  if (s.since) conds.push(`created_at >= ${s.since}`);
  if (s.until) conds.push(`created_at <= ${s.until}`);
  if (s.source_app) conds.push(`source_app LIKE '%${esc(s.source_app)}%'`);
  if (s.content_type) {
    if (s.content_type === "sensitive") {
      conds.push(`is_sensitive = 1`);
    } else {
      conds.push(`content_type = '${esc(s.content_type)}'`);
    }
  }
  if (s.is_sensitive !== undefined)
    conds.push(`is_sensitive = ${s.is_sensitive ? 1 : 0}`);
  if (s.search_terms) conds.push(`content LIKE '%${esc(s.search_terms)}%'`);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  return `SELECT ${COLS} FROM clips ${where}`;
}

function buildUnionSQL(strategies: SearchStrategy[]): string {
  const selects = strategies.map(strategyToSQL);
  return `SELECT ${COLS} FROM (${selects.join(" UNION ")}) ORDER BY created_at DESC LIMIT 50`;
}

// ── Relevance scoring ─────────────────────────────────────────────────────────

function scoreClip(clip: Clip, query: string): number {
  const q = query.toLowerCase();
  let score = 0;
  if (
    /website|url|link|site|page|visit|went to/.test(q) &&
    clip.content_type === "url"
  )
    score += 4;
  if (
    /code|snippet|function|class|script/.test(q) &&
    clip.content_type === "code"
  )
    score += 4;
  if (/api.?key|secret|password|token|credential/.test(q) && clip.is_sensitive)
    score += 4;
  if (/email/.test(q) && clip.content_type === "email") score += 4;
  if (!clip.is_sensitive) {
    const content = clip.content.toLowerCase();
    for (const word of q.split(/\s+/).filter((w) => w.length > 3)) {
      if (content.includes(word)) score += 2;
    }
  }
  if (clip.source_app) {
    const app = clip.source_app.toLowerCase();
    if (q.includes(app) || q.includes(app.split(" ")[0])) score += 3;
  }
  return score;
}

function formatClipForContext(clip: Clip, idx: number): string {
  const time = relativeTime(clip.created_at);
  const app = clip.source_app ? ` · ${clip.source_app}` : "";
  const source = clip.source_url
    ? ` · source: ${formatWebsite(clip.source_url)}`
    : "";

  if (clip.is_sensitive) {
    return `[${idx}] [${detectSecretType(clip.content)}]${app} · ${time}`;
  }
  switch (clip.content_type) {
    case "url": {
      let domain = "";
      try {
        domain = ` (${new URL(clip.content.trim()).hostname})`;
      } catch {
        /* */
      }
      return `[${idx}] URL${domain}${app}${source} · ${time}: ${truncate(clip.content.trim(), 120)}`;
    }
    case "code": {
      const lang = clip.content_lang ? ` (${clip.content_lang})` : "";
      const file = clip.source_file
        ? ` · ${clip.source_file.split("/").pop()}`
        : "";
      return `[${idx}] Code${lang}${file}${app}${source} · ${time}: ${truncate(clip.content, 100)}`;
    }
    case "email":
      return `[${idx}] Email${app}${source} · ${time}: ${clip.content.trim()}`;
    default:
      return `[${idx}] Text${app}${source} · ${time}: ${truncate(clip.content, 120)}`;
  }
}

// ── Pass 2: synthesize ────────────────────────────────────────────────────────

interface SynthResult {
  answer: string;
  relevantIndices: number[];
}

function isBroadWebsiteQuestion(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /(what|which|show|list|find|whats|what's)/.test(q) &&
    /(web\s*site|website|wesbite|site|page|link|url|looking at|looked at|visited|went to)/.test(
      q,
    )
  );
}

function formatWebsite(url: string): string {
  try {
    const parsed = new URL(url);
    const path =
      parsed.pathname && parsed.pathname !== "/"
        ? parsed.pathname.replace(/\/$/, "")
        : "";
    return `${parsed.hostname}${path}`;
  } catch {
    return truncate(url, 80);
  }
}

function itemLabel(count: number): string {
  return `${count} item${count !== 1 ? "s" : ""}`;
}

async function synthesize(
  question: string,
  clips: Clip[],
  prefs: Prefs,
): Promise<SynthResult> {
  if (clips.length === 0)
    return {
      answer: "No clipboard items found for this query.",
      relevantIndices: [],
    };

  const sorted = [...clips]
    .map((c, i) => ({ c, i, score: scoreClip(c, question) }))
    .sort((a, b) => b.score - a.score || b.c.created_at - a.c.created_at)
    .slice(0, 20);

  const context = sorted
    .map((x, rank) => formatClipForContext(x.c, rank))
    .join("\n");

  const raw = await generate(
    `You are a clipboard history assistant. Clipboard items are indexed [0], [1], etc. below, sorted by relevance.

Context: "I went to / visited / used X" means the user copied something related to X. Clipboard = what the user has copied, not browsed.

Rules:
- Answer using ONLY what you see in the items
- Be specific: name actual URLs, domains, apps, filenames
- [sensitive] entries are redacted credentials — you can confirm they exist but not reveal content
- If nothing is relevant, say so briefly
- First infer the user's intent:
  - Broad/list intent: questions like "what websites was I looking at", "what links did I copy", "what was I working on", "show code snippets", or typo versions like "wesbite". For these, return a concise list of multiple plausible items, usually the most recent 5–10. Do NOT pick a single winner unless the evidence clearly points to only one.
  - Specific/identify intent: questions with a unique clue like "money website", "github repo", "jwt from yesterday", "the red page". For these, give the best match plus nearby alternatives if there is ambiguity.
- For website/page/link questions, use both URL items and source: fields on text/code items. A copied text snippet from a page still means that page is relevant.
- If several items are plausible, say "Could be:" and list them. Better to show candidates than hallucinate certainty.
- The "relevant" array must include every item index you mention in the answer. If you list 6 websites, include all 6 indices.
- Return JSON with keys "answer" (string) and "relevant" (array of item indices that directly support your answer)

Q: ${question}

Items:
${context}

Return ONLY JSON like: {"answer":"...", "relevant":[0,2]}`,
    prefs,
  );

  try {
    const stripped = raw
      .replace(/```(?:json)?/gi, "")
      .replace(/```/g, "")
      .trim();
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as {
        answer?: string;
        relevant?: number[];
      };
      const answer = (parsed.answer ?? raw)
        .replace(
          /^(Based on (your clipboard( history)?|the (provided |above )?clipboard[^,.\n]*)[,.]?\s*)/i,
          "",
        )
        .trim();
      const relevantIndices = (parsed.relevant ?? [])
        .filter(
          (i): i is number =>
            typeof i === "number" && i >= 0 && i < sorted.length,
        )
        .map((i) => sorted[i].i); // map back to original clips array index
      return { answer, relevantIndices };
    }
  } catch {
    /* fall through */
  }

  // Fallback: plain text answer, show all sorted clips as sources
  const answer = raw
    .replace(
      /^(Based on (your clipboard( history)?|the (provided |above )?clipboard[^,.\n]*)[,.]?\s*)/i,
      "",
    )
    .trim();
  return { answer, relevantIndices: sorted.map((x) => x.i) };
}

// ── Main component ────────────────────────────────────────────────────────────

export function AIResults({ initialQuery = "" }: { initialQuery?: string }) {
  const prefs = getPreferenceValues<Prefs>();

  const [query, setQuery] = useState(initialQuery);
  const [committedQuery, setCommittedQuery] = useState(initialQuery);
  const [queryPlan, setQueryPlan] = useState<SearchStrategy[] | null>(null);
  const [isPlanLoading, setIsPlanLoading] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [relevantIds, setRelevantIds] = useState<number[] | null>(null);
  const [isSynth, setIsSynth] = useState(false);
  const synthKey = useRef("");
  const requestId = useRef(0);

  // Auto-run if launched with an initial query
  useEffect(() => {
    if (initialQuery.trim()) {
      runPlan(initialQuery.trim(), requestId.current);
    }
  }, []);

  function commit() {
    if (!query.trim()) return;
    const q = query.trim();
    setCommittedQuery(q);
    setAnswer(null);
    setRelevantIds(null);
    synthKey.current = "";
    const id = ++requestId.current;
    runPlan(q, id);
  }

  async function runPlan(q: string, id: number) {
    setIsPlanLoading(true);
    setQueryPlan(null);
    try {
      const plan = await planQuery(q, prefs);
      if (requestId.current !== id) return;
      setQueryPlan(plan);
    } catch {
      if (requestId.current === id) setQueryPlan(defaultStrategies());
    } finally {
      if (requestId.current === id) setIsPlanLoading(false);
    }
  }

  useEffect(() => {
    if (!query.trim()) {
      setAnswer(null);
      setQueryPlan(null);
      setRelevantIds(null);
      synthKey.current = "";
    }
  }, [query]);

  const sql = useMemo(
    () =>
      queryPlan
        ? buildUnionSQL(queryPlan)
        : `SELECT ${COLS} FROM clips WHERE 0`,
    [queryPlan],
  );

  const { data, isLoading, permissionView } = useSQL<ClipWithContext>(
    DB_PATH,
    sql,
  );
  const clips = data ?? [];

  // Pass 2: synthesize once clips arrive after a plan is set
  useEffect(() => {
    if (!queryPlan || clips.length === 0) return;
    const key = `${committedQuery}::${clips[0]?.id}::${clips.length}`;
    if (synthKey.current === key) return;
    synthKey.current = key;
    const id = requestId.current;
    setIsSynth(true);
    setAnswer(null);
    setRelevantIds(null);
    synthesize(committedQuery, clips, prefs)
      .then((result) => {
        if (requestId.current !== id) return;
        setAnswer(result.answer);
        setRelevantIds(result.relevantIndices);
      })
      .catch(() => {
        if (requestId.current === id) setAnswer(null);
      })
      .finally(() => {
        if (requestId.current === id) setIsSynth(false);
      });
  }, [clips, queryPlan]);

  if (permissionView) return permissionView;

  // Determine which clips to show as sources
  const sourceLimit = isBroadWebsiteQuestion(committedQuery) ? 10 : 5;
  const sourcesToShow =
    relevantIds && relevantIds.length > 0
      ? (relevantIds
          .slice(0, sourceLimit)
          .map((i) => clips[i])
          .filter(Boolean) as ClipWithContext[])
      : clips.slice(0, sourceLimit);

  const isPending =
    !isPlanLoading &&
    !isLoading &&
    !isSynth &&
    query.trim() !== committedQuery.trim();
  const isWorking = isPlanLoading || isLoading || isSynth;
  const planPhase = isPlanLoading
    ? "planning"
    : isLoading
      ? "fetching"
      : isSynth
        ? "answering"
        : null;

  return (
    <List
      isLoading={isWorking}
      isShowingDetail
      searchText={query}
      onSearchTextChange={setQuery}
      searchBarPlaceholder="Ask anything… press ↵ to search"
      navigationTitle="Clipz AI"
    >
      {sourcesToShow.length > 0 && (
        <List.Section
          title="Answer"
          subtitle={
            relevantIds && relevantIds.length > 0
              ? `${sourcesToShow.length} clickable match${sourcesToShow.length !== 1 ? "es" : ""}`
              : `${sourcesToShow.length} recent match${sourcesToShow.length !== 1 ? "es" : ""}`
          }
        >
          {sourcesToShow.map((c) => (
            <SourceItem key={c.id} clip={c} />
          ))}
        </List.Section>
      )}
      <List.Section title={sourcesToShow.length > 0 ? "AI Note" : "Answer"}>
        <AnswerCard
          answer={answer}
          planPhase={planPhase}
          isPending={isPending}
          onCommit={commit}
          totalCount={clips.length}
          shownCount={sourcesToShow.length}
          relevantCount={relevantIds?.length ?? clips.length}
          hasMatches={sourcesToShow.length > 0}
        />
      </List.Section>
    </List>
  );
}

// ── Answer card ───────────────────────────────────────────────────────────────

function AnswerCard({
  answer,
  planPhase,
  isPending,
  onCommit,
  totalCount,
  shownCount,
  relevantCount,
  hasMatches,
}: {
  answer: string | null;
  planPhase: "planning" | "fetching" | "answering" | null;
  isPending: boolean;
  onCommit: () => void;
  totalCount: number;
  shownCount: number;
  relevantCount: number;
  hasMatches: boolean;
}) {
  const title =
    planPhase === "planning"
      ? "Planning query…"
      : planPhase === "fetching"
        ? "Retrieving clips…"
        : planPhase === "answering"
          ? "Thinking…"
          : isPending
            ? "Press ↵ to search"
            : answer
              ? hasMatches
                ? `Found ${shownCount} clickable match${shownCount !== 1 ? "es" : ""}`
                : truncate(answer, 80)
              : "Ask anything…";

  const md =
    planPhase === "planning"
      ? "*Breaking down your question into search strategies…*"
      : planPhase === "fetching"
        ? "*Querying clipboard history…*"
        : planPhase === "answering"
          ? `*Analysing ${totalCount} retrieved items…*`
          : isPending
            ? "*Press **↵** to run this search.*"
            : answer
              ? `${answer}\n\n---\n*${hasMatches ? `Open/copy the matches above. ${relevantCount > 0 ? `${shownCount} shown from ${itemLabel(relevantCount)}` : `${shownCount} shown`}.` : `${itemLabel(totalCount)} searched.`}*`
              : "*Type a question and press **↵** to search.*";

  return (
    <List.Item
      icon={{ source: Icon.Stars, tintColor: Color.Purple }}
      title={title}
      detail={<List.Item.Detail markdown={md} />}
      actions={
        <ActionPanel>
          <Action
            title="Search"
            icon={Icon.MagnifyingGlass}
            onAction={onCommit}
          />
          {answer && (
            <Action
              title="Copy Answer"
              icon={Icon.Clipboard}
              shortcut={{ modifiers: ["cmd"], key: "c" }}
              onAction={async () => {
                await Clipboard.copy(answer);
                showToast({ style: Toast.Style.Success, title: "Copied!" });
              }}
            />
          )}
        </ActionPanel>
      }
    />
  );
}

// ── Source item ───────────────────────────────────────────────────────────────

interface ClipWithContext extends Clip {
  source_url: string | null;
  source_file: string | null;
}

function SourceItem({ clip }: { clip: ClipWithContext }) {
  const sensitive = clip.is_sensitive === 1;
  const isUrl = clip.content_type === "url" && !sensitive;

  const openUrl = isUrl ? clip.content.trim() : (clip.source_url ?? null);
  const hexColor = sensitive ? null : detectHexColor(clip.content);
  const isShell = !sensitive && !hexColor && isShellCommand(clip.content);

  const detailMd = hexColor
    ? `\`${hexColor}\`\n\n**RGB** ${hexToRgb(hexColor)}\n\n**HSL** ${hexToHsl(hexColor)}`
    : buildDetailMarkdown(clip);

  const fileLink = clip.source_file?.startsWith("/")
    ? `cursor://file/${clip.source_file}`
    : null;
  const sourceLabel = openUrl
    ? formatWebsite(openUrl)
    : clip.source_file
      ? clip.source_file.split("/").pop()
      : clip.source_app;
  const title = sensitive
    ? `${detectSecretType(clip.content)}  ${maskSensitiveContent(clip.content)}`
    : sourceLabel && (isUrl || clip.source_url || clip.source_file)
      ? sourceLabel
      : truncate(clip.content, 72);
  const subtitle =
    sensitive || title === truncate(clip.content, 72)
      ? undefined
      : truncate(clip.content, 90);

  return (
    <List.Item
      icon={clipListIcon(clip, { hexColor, isShell })}
      title={title}
      subtitle={subtitle}
      accessories={[
        ...(clip.source_app
          ? [{ text: clip.source_app, tooltip: "Source app" }]
          : []),
        { text: relativeTime(clip.created_at), tooltip: "Copied" },
      ]}
      detail={
        <List.Item.Detail
          markdown={detailMd}
          metadata={
            <List.Item.Detail.Metadata>
              <List.Item.Detail.Metadata.Label
                title="Copied"
                text={new Date(clip.created_at * 1000).toLocaleString()}
                icon={Icon.Clock}
              />
              {clip.source_app && (
                <List.Item.Detail.Metadata.Label
                  title="From"
                  text={clip.source_app}
                  icon={Icon.AppWindow}
                />
              )}
              {clip.source_url && (
                <List.Item.Detail.Metadata.Link
                  title="Page"
                  text={clip.source_url}
                  target={clip.source_url}
                />
              )}
              {clip.source_file && (
                <List.Item.Detail.Metadata.Label
                  title="File"
                  text={clip.source_file}
                  icon={Icon.Document}
                />
              )}
              <List.Item.Detail.Metadata.Separator />
              <List.Item.Detail.Metadata.Label
                title="Type"
                text={
                  sensitive ? detectSecretType(clip.content) : clip.content_type
                }
              />
            </List.Item.Detail.Metadata>
          }
        />
      }
      actions={
        <ActionPanel>
          {openUrl && (
            <Action
              title="Open Source Page"
              icon={Icon.Globe}
              shortcut={{ modifiers: ["cmd"], key: "o" }}
              onAction={() => open(openUrl)}
            />
          )}
          {fileLink && (
            <Action
              title="Open in Cursor"
              icon={Icon.Code}
              shortcut={{ modifiers: ["cmd"], key: "e" }}
              onAction={() => open(fileLink)}
            />
          )}
          <Action
            title="Paste to Active App"
            icon={Icon.Document}
            onAction={async () => {
              await Clipboard.paste(clip.content);
              await showHUD("Pasted ✓");
            }}
          />
          <Action
            title="Copy to Clipboard"
            icon={Icon.Clipboard}
            shortcut={{ modifiers: ["cmd"], key: "c" }}
            onAction={async () => {
              await Clipboard.copy(clip.content);
              showToast({ style: Toast.Style.Success, title: "Copied!" });
            }}
          />
          {hexColor && (
            <>
              <Action
                title="Copy as Rgb"
                icon={Icon.Clipboard}
                shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
                onAction={() => {
                  Clipboard.copy(hexToRgb(hexColor));
                  showToast({
                    style: Toast.Style.Success,
                    title: "Copied RGB!",
                  });
                }}
              />
              <Action
                title="Copy as Hsl"
                icon={Icon.Clipboard}
                shortcut={{ modifiers: ["cmd", "shift"], key: "h" }}
                onAction={() => {
                  Clipboard.copy(hexToHsl(hexColor));
                  showToast({
                    style: Toast.Style.Success,
                    title: "Copied HSL!",
                  });
                }}
              />
            </>
          )}
          {isShell && (
            <Action
              title="Run in Terminal"
              icon={Icon.Terminal}
              shortcut={{ modifiers: ["cmd"], key: "r" }}
              onAction={async () => {
                const cmd = clip.content.trim().replace(/^\$ /, "");
                const safe = cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
                await runAppleScript(
                  `tell application "Terminal"\ndo script "${safe}"\nactivate\nend tell`,
                );
              }}
            />
          )}
        </ActionPanel>
      }
    />
  );
}
