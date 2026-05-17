import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  Clipboard,
  showHUD,
  open,
  useNavigation,
  getPreferenceValues,
} from "@raycast/api";
import { runAppleScript, useSQL } from "@raycast/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Clip,
  buildSearchSQL,
  readConfig,
  resolveDBPath,
  setICloudSyncEnabled,
} from "./db";
import { AIResults } from "./ai-results";
import { SemanticResult, semanticSearch } from "./semantic-search";
import {
  buildDetailMarkdown,
  clipListIcon,
  detectHexColor,
  detectSecretType,
  groupByTime,
  hexToHsl,
  hexToRgb,
  isShellCommand,
  maskSensitiveContent,
  truncate,
} from "./utils";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

interface Prefs {
  aiMode: string;
  ollamaUrl: string;
  embeddingModel: string;
}

export default function SearchHistory() {
  const prefs = getPreferenceValues<Prefs>();
  const aiEnabled = prefs.aiMode !== "none";
  const [searchText, setSearchText] = useState("");
  const [dbPath, setDbPath] = useState(resolveDBPath());
  const [syncToICloud, setSyncToICloud] = useState(readConfig().syncToICloud);
  const [semanticResults, setSemanticResults] = useState<SemanticResult[]>([]);
  const [isSemanticLoading, setIsSemanticLoading] = useState(false);
  const [semanticError, setSemanticError] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const { push } = useNavigation();

  const sql = useMemo(() => buildSearchSQL(searchText), [searchText]);
  const { data, isLoading, permissionView, revalidate } = useSQL<Clip>(
    dbPath,
    sql,
  );

  // Re-poll the DB every 2s so newly copied items appear without reopening
  useEffect(() => {
    const t = setInterval(revalidate, 2000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const query = searchText.trim();
    if (query.length < 3) {
      setSemanticResults([]);
      setSemanticError(null);
      setIsSemanticLoading(false);
      return;
    }

    let cancelled = false;
    setIsSemanticLoading(true);
    const timer = setTimeout(() => {
      semanticSearch(dbPath, query, {
        ollamaUrl: prefs.ollamaUrl,
        embeddingModel: prefs.embeddingModel || "nomic-embed-text",
      })
        .then((results) => {
          if (cancelled) return;
          setSemanticResults(results);
          setSemanticError(null);
        })
        .catch((error) => {
          if (cancelled) return;
          setSemanticResults([]);
          setSemanticError(
            error instanceof Error ? error.message : "Semantic search failed",
          );
        })
        .finally(() => {
          if (!cancelled) setIsSemanticLoading(false);
        });
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchText, dbPath, prefs.ollamaUrl, prefs.embeddingModel]);

  if (permissionView) return permissionView;

  // Keep stale results visible while a new query loads
  const lastClips = useRef<Clip[]>([]);
  if (!isLoading && data) lastClips.current = data;
  const clips =
    isLoading && lastClips.current.length > 0
      ? lastClips.current
      : (data ?? []);

  const groups = useMemo(
    () => (searchText ? null : groupByTime(clips)),
    [clips, searchText],
  );

  function askAI() {
    push(<AIResults initialQuery={searchText} />);
  }

  async function setSync(enabled: boolean) {
    setICloudSyncEnabled(enabled);
    setSyncToICloud(enabled);
    setDbPath(resolveDBPath());
    await restartDaemon();
    await showHUD(`iCloud sync ${enabled ? "enabled" : "disabled"}`);
  }

  const renderSettingsActions = () => (
    <>
      <Action
        title={syncToICloud ? "Disable Cloud Sync" : "Enable Cloud Sync"}
        icon={syncToICloud ? Icon.XMarkCircle : Icon.Cloud}
        onAction={() => setSync(!syncToICloud)}
      />
      <Action
        title="Restart Clipz Daemon"
        icon={Icon.RotateClockwise}
        onAction={async () => {
          await restartDaemon();
          await showHUD("Clipz daemon restarted");
        }}
      />
    </>
  );

  const semanticIds = new Set(semanticResults.map((result) => result.clip.id));
  const textMatches = searchText.trim()
    ? clips.filter((clip) => !semanticIds.has(clip.id))
    : clips;

  return (
    <List
      isLoading={isLoading || isSemanticLoading}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Search clipboard history… semantic included, naturally"
      isShowingDetail={clips.length > 0 || !!searchText.trim()}
      navigationTitle="Clipz"
      selectedItemId={selectedItemId ?? undefined}
      onSelectionChange={setSelectedItemId}
    >
      <List.Section>
        {aiEnabled && (
          <List.Item
            id="ask-ai"
            icon={{ source: Icon.Stars, tintColor: Color.Purple }}
            title={
              searchText.trim()
                ? `Ask AI: "${truncate(searchText, 50)}"`
                : "Ask AI anything…"
            }
            detail={
              <List.Item.Detail
                markdown={`Ask anything about your clipboard history.\n\nExamples:\n- *What was I working on today?*\n- *Find that JWT token from yesterday*\n- *Show code snippets from VS Code*`}
              />
            }
            actions={
              <ActionPanel>
                <ActionPanel.Section>
                  <Action
                    title="Ask AI"
                    icon={{ source: Icon.Stars, tintColor: Color.Purple }}
                    onAction={askAI}
                  />
                </ActionPanel.Section>
                <ActionPanel.Section title="Settings">
                  {renderSettingsActions()}
                </ActionPanel.Section>
              </ActionPanel>
            }
          />
        )}
      </List.Section>
      {!searchText.trim() && clips.length === 0 && !isLoading ? (
        <List.Section>
          <List.Item
            id="empty"
            icon={{ source: Icon.Clipboard, tintColor: Color.SecondaryText }}
            title="No clipboard history yet"
            subtitle="Start copying. Items appear here automatically."
            actions={
              <ActionPanel>
                <ActionPanel.Section>
                  <Action
                    title="Ask AI"
                    icon={{ source: Icon.Stars, tintColor: Color.Purple }}
                    onAction={askAI}
                  />
                </ActionPanel.Section>
                <ActionPanel.Section title="Settings">
                  {renderSettingsActions()}
                </ActionPanel.Section>
              </ActionPanel>
            }
          />
        </List.Section>
      ) : searchText.trim() ? (
        <>
          {semanticError && (
            <List.Section title="Semantic Search">
              <List.Item
                id="semantic-error"
                icon={{ source: Icon.ExclamationMark, tintColor: Color.Yellow }}
                title={
                  semanticError.includes("Embedding model missing")
                    ? "Embedding Model Missing"
                    : "Semantic Search Unavailable"
                }
                subtitle={semanticError}
                actions={
                  <ActionPanel>
                    {semanticError.includes("Embedding model missing") && (
                      <Action
                        title="Pull Embedding Model"
                        icon={Icon.Download}
                        onAction={async () => {
                          await pullEmbeddingModel(
                            prefs.embeddingModel || "nomic-embed-text",
                          );
                          await showHUD("Pulling embedding model in Terminal");
                        }}
                      />
                    )}
                  </ActionPanel>
                }
              />
            </List.Section>
          )}
          {semanticResults.length > 0 && (
            <List.Section
              title="Semantic Matches"
              subtitle={`${semanticResults.length}`}
            >
              {semanticResults.map((result) => (
                <ClipItem
                  key={`semantic-${result.clip.id}`}
                  clip={result.clip}
                  semanticScore={result.score}
                  renderSettingsActions={renderSettingsActions}
                  onKeepFocus={setSelectedItemId}
                />
              ))}
            </List.Section>
          )}
          {textMatches.length > 0 && (
            <List.Section
              title="Text Matches"
              subtitle={`${textMatches.length}`}
            >
              {textMatches.map((c) => (
                <ClipItem
                  key={c.id}
                  clip={c}
                  renderSettingsActions={renderSettingsActions}
                  onKeepFocus={setSelectedItemId}
                />
              ))}
            </List.Section>
          )}
        </>
      ) : groups ? (
        groups.map((g) => (
          <List.Section
            key={g.title}
            title={g.title}
            subtitle={String(g.clips.length)}
          >
            {g.clips.map((c) => (
              <ClipItem
                key={c.id}
                clip={c}
                renderSettingsActions={renderSettingsActions}
                onKeepFocus={setSelectedItemId}
              />
            ))}
          </List.Section>
        ))
      ) : (
        clips.map((c) => (
          <ClipItem
            key={c.id}
            clip={c}
            renderSettingsActions={renderSettingsActions}
            onKeepFocus={setSelectedItemId}
          />
        ))
      )}
    </List>
  );
}

async function restartDaemon() {
  await runAppleScript(`
do shell script "launchctl unload ~/Library/LaunchAgents/com.clipz.daemon.plist 2>/dev/null || true; launchctl load ~/Library/LaunchAgents/com.clipz.daemon.plist 2>/dev/null || true"
`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function pullEmbeddingModel(model: string) {
  const safeModel = shellQuote(model || "nomic-embed-text");
  await runAppleScript(`
tell application "Terminal"
  do script "export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; ollama pull ${safeModel}"
  activate
end tell
`);
}

function usePageTitle(url: string | null): string | null {
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    fetch(url, {
      signal: AbortSignal.timeout(4000),
      headers: { "User-Agent": "Mozilla/5.0" },
    })
      .then((r) => r.text())
      .then((html) => {
        if (cancelled) return;
        const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (m)
          setTitle(
            m[1]
              .trim()
              .replace(/\s+/g, " ")
              .replace(/&amp;/g, "&")
              .replace(/&#?\w+;/g, ""),
          );
      })
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, [url]);
  return title;
}

function ClipItem({
  clip,
  semanticScore,
  renderSettingsActions,
  onKeepFocus,
}: {
  clip: Clip;
  semanticScore?: number;
  renderSettingsActions: () => JSX.Element;
  onKeepFocus: (id: string) => void;
}) {
  const itemId = `clip-${clip.id}`;
  const sensitive = clip.is_sensitive === 1;
  const isUrl = clip.content_type === "url" && !sensitive;
  const openUrl = isUrl ? clip.content.trim() : (clip.source_url ?? null);
  const fileLink = clip.source_file?.startsWith("/")
    ? `cursor://file/${clip.source_file}`
    : null;

  const hexColor = sensitive ? null : detectHexColor(clip.content);
  const isShell = !sensitive && !hexColor && isShellCommand(clip.content);
  const pageTitle = usePageTitle(isUrl ? clip.content.trim() : null);

  const codeLang = clip.content_lang ?? (isShell ? "bash" : undefined);
  const detailMd = hexColor
    ? `\`${hexColor}\`\n\n**RGB** ${hexToRgb(hexColor)}\n\n**HSL** ${hexToHsl(hexColor)}`
    : isShell || (clip.content_type === "code" && codeLang)
      ? `\`\`\`${codeLang ?? "bash"}\n${clip.content.trim().replace(/^\$ /, "")}\n\`\`\``
      : isUrl && pageTitle
        ? `## ${pageTitle}\n\n${clip.content}`
        : buildDetailMarkdown(clip);
  const sourceHint = openUrl
    ? `⌘O opens source page${clip.source_app ? ` · ${clip.source_app}` : ""}`
    : fileLink
      ? "⌘O opens source file"
      : undefined;

  return (
    <List.Item
      id={itemId}
      icon={clipListIcon(clip, { hexColor, isShell })}
      title={
        sensitive
          ? `${detectSecretType(clip.content)}  ${maskSensitiveContent(clip.content)}`
          : truncate(clip.content, 72)
      }
      subtitle={sourceHint}
      accessories={[
        ...(openUrl || fileLink
          ? [
              {
                text: "⌘O",
                tooltip: openUrl ? "Open source page" : "Open source file",
              },
            ]
          : []),
        ...(semanticScore
          ? [
              {
                text: `${Math.round(semanticScore * 100)}%`,
                tooltip: "Semantic match score",
              },
            ]
          : []),
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
              {(clip.copy_count ?? 1) > 1 && (
                <List.Item.Detail.Metadata.Label
                  title="Times copied"
                  text={String(clip.copy_count)}
                  icon={Icon.Repeat}
                />
              )}
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
                  sensitive
                    ? detectSecretType(clip.content)
                    : hexColor
                      ? "color"
                      : isShell
                        ? "shell"
                        : clip.content_type
                }
              />
              <List.Item.Detail.Metadata.Label
                title="Size"
                text={formatSize(clip.content)}
              />
            </List.Item.Detail.Metadata>
          }
        />
      }
      actions={
        <ActionPanel>
          <ActionPanel.Section>
            <Action
              title="Paste to Active App"
              icon={Icon.Document}
              onAction={async () => {
                onKeepFocus(itemId);
                await Clipboard.paste(clip.content);
                await showHUD("Pasted ✓");
              }}
            />
            <Action
              title="Copy to Clipboard"
              icon={Icon.Clipboard}
              shortcut={{ modifiers: ["cmd"], key: "c" }}
              onAction={async () => {
                onKeepFocus(itemId);
                await Clipboard.copy(clip.content);
                showToast({ style: Toast.Style.Success, title: "Copied!" });
              }}
            />
          </ActionPanel.Section>
          {(openUrl || fileLink) && (
            <ActionPanel.Section>
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
                  shortcut={{ modifiers: ["cmd"], key: "o" }}
                  onAction={() => open(fileLink)}
                />
              )}
            </ActionPanel.Section>
          )}
          {hexColor && (
            <ActionPanel.Section title="Copy Color As">
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
            </ActionPanel.Section>
          )}
          {clip.content_html && (
            <ActionPanel.Section>
              <Action
                title="Preview Original Formatting"
                icon={Icon.Eye}
                shortcut={{ modifiers: ["cmd"], key: "p" }}
                onAction={() => {
                  const tmp = join(tmpdir(), `clipz-preview-${clip.id}.html`);
                  const wrapped = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:20px;background:#1e1e1e}</style></head><body>${clip.content_html}</body></html>`;
                  writeFileSync(tmp, wrapped);
                  open(tmp);
                }}
              />
            </ActionPanel.Section>
          )}
          {isShell && (
            <ActionPanel.Section>
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
            </ActionPanel.Section>
          )}
          <ActionPanel.Section title="Settings">
            {renderSettingsActions()}
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

function formatSize(content: string): string {
  const lines = content.split("\n").length;
  const chars = content.length;
  if (lines > 1) return `${lines} lines · ${chars.toLocaleString()} chars`;
  return `${content.trim().split(/\s+/).length} words · ${chars.toLocaleString()} chars`;
}
