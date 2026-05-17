import { Color, Icon, open } from "@raycast/api";
import { runAppleScript } from "@raycast/utils";
import { Clip } from "./db";

export function truncate(text: string, maxLen: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length <= maxLen ? s : `${s.slice(0, maxLen - 1)}…`;
}

export function relativeTime(unixSec: number): string {
  const diff = Date.now() / 1000 - unixSec;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSec * 1000).toLocaleDateString();
}

export function clipIcon(
  contentType: string,
  isSensitive: number,
): { source: Icon; tintColor?: Color } {
  if (isSensitive) return { source: Icon.Lock, tintColor: Color.Red };
  switch (contentType) {
    case "url":
      return { source: Icon.Globe, tintColor: Color.Blue };
    case "code":
      return { source: Icon.Code, tintColor: Color.Purple };
    case "email":
      return { source: Icon.Envelope, tintColor: Color.Green };
    default:
      return { source: Icon.Text };
  }
}

export function clipSubtitle(clip: Clip): string {
  if (clip.is_sensitive) return "sensitive";
  switch (clip.content_type) {
    case "url": {
      try {
        return new URL(clip.content.trim()).hostname;
      } catch {
        return "url";
      }
    }
    case "code": {
      const lines = clip.content.split("\n").length;
      return `${lines} line${lines !== 1 ? "s" : ""} · ${detectLang(clip.content)}`;
    }
    case "email":
      return "email";
    default: {
      const words = clip.content.trim().split(/\s+/).length;
      const lines = clip.content.split("\n").length;
      if (lines > 1) return `${lines} lines`;
      if (words > 10) return `${words} words`;
      return "";
    }
  }
}

export function detectLang(code: string): string {
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP)\b/i.test(code))
    return "sql";
  if (/<\/?[a-z][\s\S]*>/i.test(code)) return "html";
  if (/\bfn\s+\w+|let\s+mut\b/.test(code)) return "rust";
  if (/\bfunc\s+\w+.*\{/.test(code) && !/function/.test(code)) return "go";
  if (/\bdef\s+\w+|import\s+\w+\s*$|:\s*$/m.test(code)) return "python";
  if (/\bconst\b|\blet\b|\bvar\b|\b=>\b/.test(code)) return "typescript";
  if (/\bpublic\s+class\b|\bSystem\.out\./.test(code)) return "java";
  return "text";
}

export function detectSecretType(content: string): string {
  const t = content.trim();
  if (t.startsWith("sk-ant-")) return "Anthropic API Key";
  if (t.startsWith("sk-")) return "OpenAI API Key";
  if (t.startsWith("ghp_")) return "GitHub Token";
  if (t.startsWith("github_pat_")) return "GitHub PAT";
  if (t.startsWith("ghs_")) return "GitHub App Token";
  if (t.startsWith("gho_")) return "GitHub OAuth Token";
  if (t.startsWith("glpat-")) return "GitLab Token";
  if (t.startsWith("npm_")) return "npm Token";
  if (t.startsWith("pypi-")) return "PyPI Token";
  if (t.startsWith("SG.")) return "SendGrid Key";
  if (/^xox[bpoa]-/.test(t)) return "Slack Token";
  if (t.startsWith("-----BEGIN")) return "Private Key";
  if (/^eyJ[A-Za-z0-9_-]+\.eyJ/.test(t)) return "JWT";
  if (t.startsWith("AKIA")) return "AWS Access Key";
  if (t.startsWith("AIza")) return "Google API Key";
  if (t.startsWith("ya29.")) return "Google OAuth Token";
  if (/^(?:postgres|mysql|mongodb(?:\+srv)?|redis):\/\/[^@]+@/.test(t))
    return "DB Connection String";
  if (/^Bearer\s+/i.test(t)) return "Bearer Token";
  if (
    t.includes("\n") &&
    t.split("\n").filter((l) => /\w+=.+/.test(l)).length >= 2
  )
    return "Credentials (.env)";
  // Extract the variable name for a cleaner label (e.g. OPENROUTER_API_KEY=xxx → "OPENROUTER API Key")
  const envMatch = t.match(/^([A-Z][A-Z0-9_]{2,})\s*[:=]/);
  if (envMatch) {
    const name = envMatch[1]
      .replace(/_/g, " ")
      .replace(/\b(API|KEY|SECRET|TOKEN|AUTH)\b/gi, (w) => w.toUpperCase());
    return (
      name.charAt(0).toUpperCase() +
      name
        .slice(1)
        .toLowerCase()
        .replace(/\b(api|key|secret|token|auth)\b/g, (w) => w.toUpperCase())
    );
  }
  if (/(?:api[_-]?key|secret|password|token)\s*[:=]/i.test(t))
    return "Credential";
  return "Secret";
}

export function maskSensitiveContent(content: string): string {
  const t = content.trim();
  if (t.length <= 8) return "*".repeat(t.length);
  // For .env-style multi-line blocks, show key names with masked values
  const lines = t.split("\n");
  if (lines.length >= 2) {
    const keyLines = lines
      .filter((l) => l.includes("="))
      .slice(0, 4)
      .map((l) => {
        const eq = l.indexOf("=");
        return `${l.slice(0, eq).trim()}=****`;
      });
    if (keyLines.length >= 2) {
      return keyLines.join("  ") + (lines.length > 4 ? "  …" : "");
    }
  }
  // JWT: show algorithm from header if decodable
  if (t.startsWith("eyJ")) {
    try {
      const padded = t.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
      const header = JSON.parse(Buffer.from(padded, "base64").toString()) as {
        alg?: string;
      };
      const alg = header.alg ?? "JWT";
      return `${alg} eyJ****${t.slice(-4)}`;
    } catch {
      return `eyJ****${t.slice(-4)}`;
    }
  }
  // Default: show prefix (enough to recognise the key format) + **** + last 4
  const prefixLen = Math.min(10, Math.floor(t.length * 0.3));
  return `${t.slice(0, prefixLen)}****${t.slice(-4)}`;
}

export function buildDetailMarkdown(clip: Clip): string {
  if (clip.is_sensitive) {
    const type = detectSecretType(clip.content);
    const t = clip.content.trim();
    const lines = t.split("\n");
    const isEnv =
      lines.length >= 2 && lines.filter((l) => /\w+=.+/.test(l)).length >= 2;

    let preview: string;
    if (isEnv) {
      preview = lines
        .filter((l) => l.trim())
        .slice(0, 6)
        .map((l) => {
          const eq = l.indexOf("=");
          return eq > 0 ? `${l.slice(0, eq).trim()} = ****` : "****";
        })
        .join("\n");
      if (lines.length > 6) preview += "\n...";
      preview = "```\n" + preview + "\n```";
    } else if (t.startsWith("eyJ")) {
      const masked = maskSensitiveContent(t);
      preview = `\`${masked}\``;
    } else {
      const prefixLen = Math.min(12, Math.floor(t.length * 0.35));
      preview = `\`${t.slice(0, prefixLen)}${"*".repeat(Math.max(6, Math.min(12, t.length - prefixLen - 4)))}${t.slice(-4)}\``;
    }

    return `**${type}**\n\n${preview}\n\n*↵ paste  ·  ⌘C copy*`;
  }

  switch (clip.content_type) {
    case "url":
      return `${clip.content}`;

    case "code": {
      const lang = detectLang(clip.content);
      return `\`\`\`${lang}\n${clip.content}\n\`\`\``;
    }

    case "email":
      return `**${clip.content}**`;

    default:
      // Plain text — no code block, just readable
      return clip.content;
  }
}

// ── Color ─────────────────────────────────────────────────────────────────────

export function detectHexColor(content: string): string | null {
  const t = content.trim();
  if (/^#[0-9a-f]{6}$/i.test(t)) return t.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(t)) {
    const [r, g, b] = t
      .slice(1)
      .split("")
      .map((c) => c + c);
    return `#${r}${g}${b}`;
  }
  return null;
}

export function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

export function hexToHsl(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return `hsl(0, 0%, ${Math.round(l * 100)}%)`;
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return `hsl(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

// ── Shell command ─────────────────────────────────────────────────────────────

const SHELL_RE =
  /^(\$ |sudo |git |npm |yarn |pnpm |brew |pip3? |python3? |node |bun |deno |docker |kubectl |curl |wget |ls |cd |mkdir |rm |cp |mv |grep |find |chmod |ssh )/;

export function isShellCommand(content: string): boolean {
  return !content.includes("\n") && SHELL_RE.test(content.trim());
}

// ── (kept for any callers) ────────────────────────────────────────────────────

export function withTextFragment(url: string, text: string): string {
  const base = url.split("#")[0];
  const normalized = text.trim().replace(/\s+/g, " ");

  if (!normalized) return base;

  const textStart = normalized.slice(0, 60).trimEnd();
  const textEnd =
    normalized.length > 120 ? normalized.slice(-60).trimStart() : "";

  const fragment = textEnd
    ? `${encodeURIComponent(textStart)},${encodeURIComponent(textEnd)}`
    : encodeURIComponent(textStart);

  return `${base}#:~:text=${fragment}`;
}

function appleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildFindTextScript(text: string): string {
  return `
(() => {
  const normalized = ${JSON.stringify(text.trim().replace(/\s+/g, " "))};
  if (!normalized) return false;

  const queries = [
    normalized,
    normalized.slice(0, 120).trim(),
    normalized.slice(0, 80).trim(),
    normalized.slice(0, 50).trim(),
  ].filter(Boolean);

  window.getSelection()?.removeAllRanges();

  for (const query of queries) {
    if (window.find(query, false, false, true, false, false, false)) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        try {
          const marker = document.createElement("mark");
          marker.style.background = "#fff176";
          marker.style.color = "inherit";
          marker.style.padding = "0 2px";
          marker.style.borderRadius = "2px";
          range.surroundContents(marker);
          marker.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
        } catch {
          range.startContainer.parentElement?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
        }
      }
      return true;
    }
  }

  return false;
})();`;
}

const CHROME_LIKE = new Set([
  "Google Chrome",
  "Google Chrome Canary",
  "Chromium",
  "Arc",
  "Brave Browser",
  "Microsoft Edge",
  "Opera",
  "Vivaldi",
]);

export async function openTextFragment(
  url: string,
  text: string,
  sourceApp: string | null,
) {
  const browser =
    sourceApp && CHROME_LIKE.has(sourceApp) ? sourceApp : "Google Chrome";
  const safeUrl = appleScriptString(url);
  const safeScript = appleScriptString(buildFindTextScript(text));

  try {
    await runAppleScript(
      `
tell application "${browser}"
  activate
  open location "${safeUrl}"
  delay 1
  tell active tab of front window to execute javascript "${safeScript}"
end tell
`,
    );
  } catch {
    await open(url);
  }
}

// Group clips into time buckets for the browsing view
export interface ClipGroup {
  title: string;
  clips: Clip[];
}

export function groupByTime(clips: Clip[]): ClipGroup[] {
  const now = new Date();
  const startOfToday =
    new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
  const startOfYesterday = startOfToday - 86400;
  const startOfWeek = startOfToday - 7 * 86400;

  const buckets: ClipGroup[] = [
    { title: "Today", clips: [] },
    { title: "Yesterday", clips: [] },
    { title: "This Week", clips: [] },
    { title: "Older", clips: [] },
  ];

  for (const clip of clips) {
    if (clip.created_at >= startOfToday) buckets[0].clips.push(clip);
    else if (clip.created_at >= startOfYesterday) buckets[1].clips.push(clip);
    else if (clip.created_at >= startOfWeek) buckets[2].clips.push(clip);
    else buckets[3].clips.push(clip);
  }

  return buckets.filter((b) => b.clips.length > 0);
}
