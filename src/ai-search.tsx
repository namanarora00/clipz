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
} from "@raycast/api";
import { useSQL } from "@raycast/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { Clip, DB_PATH } from "./db";
import {
  buildDetailMarkdown,
  clipIcon,
  clipSubtitle,
  relativeTime,
  truncate,
} from "./utils";

interface Prefs {
  ollamaUrl: string;
  ollamaModel: string;
}

interface ParsedQuery {
  since: number | null;
  until: number | null;
  source_app: string | null;
  content_type: string | null;
  search_terms: string | null;
  explanation: string;
}

// ── Ollama helpers ────────────────────────────────────────────────────────────

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

function extractJSON(raw: string): ParsedQuery {
  const stripped = raw
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
  const match = stripped.match(/\{[\s\S]*\}/); // greedy — outermost object
  if (!match) throw new Error("No JSON object in model response");
  try {
    return JSON.parse(match[0]) as ParsedQuery;
  } catch {
    // Patch common model mistakes before giving up
    const cleaned = match[0]
      .replace(/,\s*([}\]])/g, "$1") // trailing commas
      .replace(/:\s*None\b/g, ": null")
      .replace(/:\s*True\b/g, ": true")
      .replace(/:\s*False\b/g, ": false");
    return JSON.parse(cleaned) as ParsedQuery;
  }
}

async function parseQuery(
  query: string,
  url: string,
  model: string,
): Promise<ParsedQuery> {
  const now = Math.floor(Date.now() / 1000);
  const raw = await ollamaGenerate(
    `Output ONLY a JSON object — no markdown, no explanation, nothing else.

Current unix time: ${now}
Today started: ${now - (now % 86400)}
Yesterday started: ${now - (now % 86400) - 86400}
One week ago: ${now - 7 * 86400}

Query: "${query}"

Rules:
- search_terms: ONLY set when user wants specific content ("find JWT" → "JWT"). For context questions ("what was I working on today") set to null.
- source_app: only if explicitly named. Otherwise null.
- since/until: unix timestamps when time is mentioned, else null.

Output this exact JSON shape:
{"since":null,"until":null,"source_app":null,"content_type":null,"search_terms":null,"explanation":"one sentence"}`,
    url,
    model,
  );
  return extractJSON(raw);
}

async function synthesizeAnswer(
  question: string,
  clips: Clip[],
  url: string,
  model: string,
): Promise<string> {
  if (clips.length === 0) return "No clipboard items found for that query.";

  const context = clips
    .slice(0, 30)
    .map((c, i) => {
      const when = relativeTime(c.created_at);
      const app = c.source_app ? ` [${c.source_app}]` : "";
      const preview = c.is_sensitive
        ? "[sensitive item hidden]"
        : truncate(c.content, 180);
      return `${i + 1}.${app} ${when}: ${preview}`;
    })
    .join("\n");

  return ollamaGenerate(
    `You are answering a question about someone's clipboard history. Be concise and specific.

Question: "${question}"

Clipboard history (newest first):
${context}

Answer in 2–4 sentences. Mention specific things you actually see (app names, topics, filenames, technologies). Don't say "based on your clipboard history" — just answer directly as if you know.`,
    url,
    model,
  );
}

// ── SQL builder ───────────────────────────────────────────────────────────────

function buildSQL(p: ParsedQuery): string {
  const conds: string[] = [];
  if (p.since) conds.push(`created_at >= ${p.since}`);
  if (p.until) conds.push(`created_at <= ${p.until}`);
  if (p.source_app)
    conds.push(`source_app LIKE '%${p.source_app.replace(/'/g, "''")}%'`);
  if (p.content_type)
    conds.push(`content_type = '${p.content_type.replace(/'/g, "''")}'`);
  if (p.search_terms)
    conds.push(`content LIKE '%${p.search_terms.replace(/'/g, "''")}%'`);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  return `SELECT id,content,content_type,is_sensitive,source_app,created_at FROM clips ${where} ORDER BY created_at DESC LIMIT 80`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AISearch() {
  const prefs = getPreferenceValues<Prefs>();

  const [searchText, setSearchText] = useState("");
  const [parsed, setParsed] = useState<ParsedQuery | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [isSynthesizing, setIsSynthesizing] = useState(false);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const synthKey = useRef(""); // tracks which query we've synthesised for

  // Warm up Ollama on mount
  useEffect(() => {
    ollamaGenerate("hi", prefs.ollamaUrl, prefs.ollamaModel).catch(() => null);
  }, []);

  function handleSearch(q: string) {
    setSearchText(q);
    if (debounce.current) clearTimeout(debounce.current);

    if (!q.trim() || q.length < 2) {
      setParsed(null);
      setAnswer(null);
      synthKey.current = "";
      return;
    }

    debounce.current = setTimeout(async () => {
      setIsParsing(true);
      setAnswer(null);
      synthKey.current = "";
      try {
        const result = await parseQuery(q, prefs.ollamaUrl, prefs.ollamaModel);
        setParsed(result);
      } catch (e) {
        showToast({
          style: Toast.Style.Failure,
          title: "AI parse failed — showing recent clips",
          message: String(e),
        });
        // Fallback: show recent clips with no filters so results always appear
        setParsed({
          since: null,
          until: null,
          source_app: null,
          content_type: null,
          search_terms: null,
          explanation: `Recent clips (AI parse failed)`,
        });
      } finally {
        setIsParsing(false);
      }
    }, 500);
  }

  const sql = useMemo(() => {
    if (!searchText.trim() || !parsed)
      return "SELECT id,content,content_type,is_sensitive,source_app,created_at FROM clips WHERE 0";
    return buildSQL(parsed);
  }, [searchText, parsed]);

  const { data, isLoading, permissionView } = useSQL<Clip>(DB_PATH, sql);
  const clips = data ?? [];

  // Step 2: synthesise answer once clips arrive for this query
  useEffect(() => {
    if (!parsed || !searchText || clips.length === 0) return;
    const key = `${searchText}::${clips[0]?.id}`;
    if (synthKey.current === key) return; // already done for this result set
    synthKey.current = key;

    setIsSynthesizing(true);
    setAnswer(null);
    synthesizeAnswer(searchText, clips, prefs.ollamaUrl, prefs.ollamaModel)
      .then(setAnswer)
      .catch(() => setAnswer(null))
      .finally(() => setIsSynthesizing(false));
  }, [clips, parsed, searchText]);

  if (permissionView) return permissionView;

  const loading = isLoading || isParsing;

  return (
    <List
      isLoading={loading}
      onSearchTextChange={handleSearch}
      searchBarPlaceholder='Ask anything — "what was I working on today?", "find that JWT token"…'
      isShowingDetail={clips.length > 0 || !!answer || isSynthesizing}
      navigationTitle="Clipz AI"
    >
      {!searchText.trim() ? (
        <List.EmptyView
          icon={{ source: Icon.Stars, tintColor: Color.Purple }}
          title="Ask about your clipboard"
          description={
            'Try:\n"What was I working on today?"\n"Find that API key from yesterday"\n"Show code snippets from VS Code"'
          }
        />
      ) : loading ? (
        <List.EmptyView
          icon={{ source: Icon.CircleProgress, tintColor: Color.Blue }}
          title="Searching…"
        />
      ) : clips.length === 0 ? (
        <List.EmptyView
          icon={{
            source: Icon.MagnifyingGlass,
            tintColor: Color.SecondaryText,
          }}
          title="No matching clips"
          description={parsed?.explanation ?? "Try rephrasing"}
        />
      ) : (
        <>
          {/* AI Answer card */}
          <List.Section title="Answer">
            <AnswerItem
              answer={answer}
              isSynthesizing={isSynthesizing}
              clipCount={clips.length}
            />
          </List.Section>

          {/* Source clips */}
          <List.Section
            title="Sources"
            subtitle={`${clips.length} clip${clips.length !== 1 ? "s" : ""}`}
          >
            {clips.map((clip) => (
              <SourceClipItem key={clip.id} clip={clip} />
            ))}
          </List.Section>
        </>
      )}
    </List>
  );
}

// ── Answer card ───────────────────────────────────────────────────────────────

function AnswerItem({
  answer,
  isSynthesizing,
  clipCount,
}: {
  answer: string | null;
  isSynthesizing: boolean;
  clipCount: number;
}) {
  const title = isSynthesizing
    ? "Thinking…"
    : answer
      ? truncate(answer, 75)
      : "No answer generated";

  const detailMarkdown = isSynthesizing
    ? "*Synthesising answer from clipboard history…*"
    : answer
      ? `${answer}\n\n---\n*Synthesised from ${clipCount} clipboard item${clipCount !== 1 ? "s" : ""}*`
      : "*Could not generate answer.*";

  return (
    <List.Item
      icon={{ source: Icon.Stars, tintColor: Color.Purple }}
      title={title}
      detail={
        <List.Item.Detail
          markdown={detailMarkdown}
          metadata={
            answer ? (
              <List.Item.Detail.Metadata>
                <List.Item.Detail.Metadata.Label
                  title="Sources"
                  text={`${clipCount} clipboard item${clipCount !== 1 ? "s" : ""}`}
                  icon={Icon.Clipboard}
                />
              </List.Item.Detail.Metadata>
            ) : undefined
          }
        />
      }
      actions={
        answer ? (
          <ActionPanel>
            <Action
              title="Copy Answer"
              icon={Icon.Clipboard}
              onAction={async () => {
                await Clipboard.copy(answer);
                showToast({
                  style: Toast.Style.Success,
                  title: "Answer copied!",
                });
              }}
            />
          </ActionPanel>
        ) : (
          <ActionPanel />
        )
      }
    />
  );
}

// ── Source clip ───────────────────────────────────────────────────────────────

function SourceClipItem({ clip }: { clip: Clip }) {
  const sensitive = clip.is_sensitive === 1;
  const isUrl = clip.content_type === "url" && !sensitive;

  return (
    <List.Item
      icon={clipIcon(clip.content_type, clip.is_sensitive)}
      title={sensitive ? "Sensitive item" : truncate(clip.content, 70)}
      subtitle={clipSubtitle(clip)}
      accessories={[
        clip.source_app
          ? { tag: { value: clip.source_app, color: Color.SecondaryText } }
          : {},
        {
          text: {
            value: relativeTime(clip.created_at),
            color: Color.SecondaryText,
          },
        },
      ]}
      detail={
        <List.Item.Detail
          markdown={buildDetailMarkdown(clip)}
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
              <List.Item.Detail.Metadata.Separator />
              <List.Item.Detail.Metadata.Label
                title="Type"
                text={sensitive ? "sensitive" : clip.content_type}
              />
            </List.Item.Detail.Metadata>
          }
        />
      }
      actions={
        <ActionPanel>
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
          {isUrl && (
            <Action
              title="Open in Browser"
              icon={Icon.Globe}
              shortcut={{ modifiers: ["cmd"], key: "o" }}
              onAction={() => open(clip.content.trim())}
            />
          )}
        </ActionPanel>
      }
    />
  );
}
