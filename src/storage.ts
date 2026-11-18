import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  CommentCategory,
  CommentType,
  DisplayMode,
  ExtensionConfig,
  LoadedSidecarData,
  NormalizedComment,
  RawCommentEntry,
  SidecarCommentFile,
} from "./types";

const VALID_CATEGORIES = new Set<CommentCategory>([
  "explain",
  "flow",
  "business-rule",
  "warning",
  "note",
]);

const VALID_DISPLAY_MODES = new Set<DisplayMode>([
  "all",
  "inlineOnly",
  "threadsOnly",
  "off",
]);

export function getExtensionConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration("aiExplainComments");
  const rawMode = cfg.get<string>("displayMode", "all");
  const displayMode: DisplayMode = VALID_DISPLAY_MODES.has(rawMode as DisplayMode)
    ? (rawMode as DisplayMode)
    : "all";

  const storageFolderRaw = cfg.get<string>("storageFolder", ".ai-review").trim();
  const storageFolder = storageFolderRaw.length > 0 ? storageFolderRaw : ".ai-review";

  const inlineMaxLength = Math.max(
    20,
    Math.min(300, cfg.get<number>("inlineMaxLength", 100))
  );
  const expandThreadsByDefault = cfg.get<boolean>("expandThreadsByDefault", false);

  return {
    storageFolder,
    displayMode,
    inlineMaxLength,
    expandThreadsByDefault,
  };
}

export function getCategoryIcon(category: CommentCategory): string {
  switch (category) {
    case "flow":
      return "🔀";
    case "business-rule":
      return "📋";
    case "warning":
      return "⚠️";
    case "note":
      return "📝";
    case "explain":
    default:
      return "💡";
  }
}

export function getCategoryLabel(category: CommentCategory): string {
  switch (category) {
    case "flow":
      return "Flow";
    case "business-rule":
      return "Business Rule";
    case "warning":
      return "Warning";
    case "note":
      return "Note";
    case "explain":
    default:
      return "Explain";
  }
}

export function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

export function isSidecarOrIgnoredUri(
  uri: vscode.Uri,
  storageFolder: string
): boolean {
  if (uri.scheme !== "file") {
    return true;
  }
  const normalizedPath = toForwardSlashes(uri.fsPath).toLowerCase();
  if (normalizedPath.endsWith(".comments.json")) {
    return true;
  }
  const folderClean = toForwardSlashes(storageFolder)
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  if (folderClean.length > 0 && normalizedPath.includes(`/${folderClean}/`)) {
    return true;
  }
  return false;
}

export interface SidecarLocation {
  sidecarUri: vscode.Uri;
  workspaceFolder?: vscode.WorkspaceFolder;
  targetFile: string;
}

export function resolveSidecarLocation(
  documentUri: vscode.Uri
): SidecarLocation | undefined {
  const config = getExtensionConfig();
  if (isSidecarOrIgnoredUri(documentUri, config.storageFolder)) {
    return undefined;
  }

  const primaryFolder = vscode.workspace.getWorkspaceFolder(documentUri);
  const primaryLoc = primaryFolder
    ? buildLocationForRoot(
        documentUri,
        primaryFolder.uri.fsPath,
        config.storageFolder,
        primaryFolder
      )
    : undefined;

  if (primaryLoc && fs.existsSync(primaryLoc.sidecarUri.fsPath)) {
    return primaryLoc;
  }

  // Fallback for multi-root workspaces where the sidecar lives under another workspace folder
  const allFolders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of allFolders) {
    if (primaryFolder && folder.uri.toString() === primaryFolder.uri.toString()) {
      continue;
    }
    const candidate = buildLocationForRoot(
      documentUri,
      folder.uri.fsPath,
      config.storageFolder,
      folder
    );
    if (candidate && fs.existsSync(candidate.sidecarUri.fsPath)) {
      return candidate;
    }
  }

  // Check file's directory (when no workspace is open) and up to 2 ancestor directories
  const startDir = primaryFolder
    ? primaryFolder.uri.fsPath
    : path.dirname(documentUri.fsPath);

  if (!primaryFolder) {
    const localCandidate = buildLocationForRoot(
      documentUri,
      startDir,
      config.storageFolder
    );
    if (localCandidate && fs.existsSync(localCandidate.sidecarUri.fsPath)) {
      return localCandidate;
    }
  }

  let currentDir = startDir;
  for (let depth = 0; depth < 2; depth++) {
    const parentDir = path.dirname(currentDir);
    if (!parentDir || parentDir === currentDir) {
      break;
    }
    const ancestorCandidate = buildLocationForRoot(
      documentUri,
      parentDir,
      config.storageFolder,
      primaryFolder
    );
    if (ancestorCandidate && fs.existsSync(ancestorCandidate.sidecarUri.fsPath)) {
      return ancestorCandidate;
    }
    currentDir = parentDir;
  }

  return (
    primaryLoc ??
    buildLocationForRoot(
      documentUri,
      path.dirname(documentUri.fsPath),
      config.storageFolder
    )
  );
}

function buildLocationForRoot(
  documentUri: vscode.Uri,
  rootFsPath: string,
  storageFolder: string,
  workspaceFolder?: vscode.WorkspaceFolder
): SidecarLocation | undefined {
  const relative = path.relative(rootFsPath, documentUri.fsPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  const targetFile = toForwardSlashes(relative);
  const sidecarFsPath = path.join(
    rootFsPath,
    storageFolder,
    `${relative}.comments.json`
  );
  return {
    sidecarUri: vscode.Uri.file(sidecarFsPath),
    workspaceFolder,
    targetFile,
  };
}

export class SidecarStorage {
  private readonly cache = new Map<string, LoadedSidecarData>();
  private readonly parseErrorWarned = new Set<string>();

  public clearCacheForSidecar(sidecarUri: vscode.Uri): void {
    const key = sidecarUri.fsPath.toLowerCase();
    for (const [docKey, loaded] of this.cache.entries()) {
      if (loaded.sidecarUri.fsPath.toLowerCase() === key) {
        this.cache.delete(docKey);
      }
    }
    this.parseErrorWarned.delete(key);
  }

  public clearAllCache(): void {
    this.cache.clear();
    this.parseErrorWarned.clear();
  }

  public async loadForDocument(
    document: vscode.TextDocument
  ): Promise<LoadedSidecarData | undefined> {
    const location = resolveSidecarLocation(document.uri);
    if (!location) {
      return undefined;
    }

    let rawContent: string;
    try {
      rawContent = await fs.promises.readFile(location.sidecarUri.fsPath, "utf8");
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        this.cache.delete(document.uri.toString());
        return undefined;
      }
      throw err;
    }

    let parsed: SidecarCommentFile;
    try {
      parsed = JSON.parse(rawContent) as SidecarCommentFile;
    } catch (err: unknown) {
      const sidecarKey = location.sidecarUri.fsPath.toLowerCase();
      if (!this.parseErrorWarned.has(sidecarKey)) {
        this.parseErrorWarned.add(sidecarKey);
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showWarningMessage(
          `AI Explain: Invalid JSON in ${location.targetFile}.comments.json (${msg})`
        );
      }
      return undefined;
    }

    this.parseErrorWarned.delete(location.sidecarUri.fsPath.toLowerCase());

    const rawEntries = Array.isArray(parsed.comments) ? parsed.comments : [];
    const normalized = rawEntries
      .filter((entry) => entry && typeof entry.comment === "string" && entry.comment.trim().length > 0)
      .map((entry, idx) => normalizeEntry(entry, idx, document));

    const loaded: LoadedSidecarData = {
      sidecarUri: location.sidecarUri,
      workspaceFolder: location.workspaceFolder,
      targetFile: parsed.targetFile || location.targetFile,
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : undefined,
      updatedAt: parsed.updatedAt,
      comments: normalized,
    };

    this.cache.set(document.uri.toString(), loaded);
    return loaded;
  }

  public getCachedForDocument(
    documentUri: vscode.Uri
  ): LoadedSidecarData | undefined {
    return this.cache.get(documentUri.toString());
  }

  public async readOrInitRawFile(
    documentUri: vscode.Uri
  ): Promise<{ location: SidecarLocation; data: SidecarCommentFile } | undefined> {
    const location = resolveSidecarLocation(documentUri);
    if (!location) {
      return undefined;
    }

    try {
      const raw = await fs.promises.readFile(location.sidecarUri.fsPath, "utf8");
      const parsed = JSON.parse(raw) as SidecarCommentFile;
      return {
        location,
        data: {
          version: typeof parsed.version === "number" ? parsed.version : 1,
          targetFile: parsed.targetFile || location.targetFile,
          summary: parsed.summary,
          updatedAt: parsed.updatedAt,
          comments: Array.isArray(parsed.comments) ? parsed.comments : [],
        },
      };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        throw err;
      }
      return {
        location,
        data: {
          version: 1,
          targetFile: location.targetFile,
          summary: "",
          updatedAt: new Date().toISOString(),
          comments: [],
        },
      };
    }
  }

  public async writeRawFile(
    location: SidecarLocation,
    data: SidecarCommentFile
  ): Promise<void> {
    const dir = path.dirname(location.sidecarUri.fsPath);
    await fs.promises.mkdir(dir, { recursive: true });
    data.updatedAt = new Date().toISOString();
    await fs.promises.writeFile(
      location.sidecarUri.fsPath,
      JSON.stringify(data, null, 2) + "\n",
      "utf8"
    );
    this.clearCacheForSidecar(location.sidecarUri);
  }

  public async addComment(
    document: vscode.TextDocument,
    entry: RawCommentEntry
  ): Promise<SidecarLocation | undefined> {
    const loaded = await this.readOrInitRawFile(document.uri);
    if (!loaded) {
      return undefined;
    }

    const now = new Date().toISOString();
    const startLine = entry.startLine ?? entry.line ?? 1;
    const endLine = entry.endLine ?? startLine;
    const type: CommentType =
      entry.type ?? (endLine > startLine ? "block" : "line");

    const anchorIdx = Math.max(0, Math.min(startLine - 1, document.lineCount - 1));
    const anchorSnippet =
      entry.anchorText ?? document.lineAt(anchorIdx).text.trim().slice(0, 80);

    const newEntry: RawCommentEntry = {
      id: entry.id || generateCommentId(type, startLine, endLine),
      type,
      ...(type === "line"
        ? { line: startLine }
        : { startLine, endLine }),
      ...(entry.title ? { title: entry.title.trim() } : {}),
      category: entry.category ?? "explain",
      comment: entry.comment.trim(),
      ...(anchorSnippet.length >= 4 ? { anchorText: anchorSnippet } : {}),
      updatedAt: now,
    };

    loaded.data.comments.push(newEntry);
    await this.writeRawFile(loaded.location, loaded.data);
    return loaded.location;
  }

  public async updateComment(
    documentUri: vscode.Uri,
    commentId: string,
    newCommentText: string,
    newTitle?: string
  ): Promise<boolean> {
    const loaded = await this.readOrInitRawFile(documentUri);
    if (!loaded) {
      return false;
    }

    const idx = loaded.data.comments.findIndex((c, i) => {
      const start = c.startLine ?? c.line ?? 1;
      const end = c.endLine ?? start;
      const type: CommentType = c.type ?? (end > start ? "block" : "line");
      const fallbackId = `c_${i}_${type}_${start}_${end}`;
      return (c.id || fallbackId) === commentId;
    });

    if (idx === -1) {
      return false;
    }

    loaded.data.comments[idx].comment = newCommentText.trim();
    if (newTitle !== undefined) {
      loaded.data.comments[idx].title = newTitle.trim() || undefined;
    }
    loaded.data.comments[idx].updatedAt = new Date().toISOString();
    await this.writeRawFile(loaded.location, loaded.data);
    return true;
  }

  public async deleteComment(
    documentUri: vscode.Uri,
    commentId: string
  ): Promise<boolean> {
    const loaded = await this.readOrInitRawFile(documentUri);
    if (!loaded) {
      return false;
    }

    const beforeCount = loaded.data.comments.length;
    loaded.data.comments = loaded.data.comments.filter((c, i) => {
      const start = c.startLine ?? c.line ?? 1;
      const end = c.endLine ?? start;
      const type: CommentType = c.type ?? (end > start ? "block" : "line");
      const fallbackId = `c_${i}_${type}_${start}_${end}`;
      return (c.id || fallbackId) !== commentId;
    });

    if (loaded.data.comments.length === beforeCount) {
      return false;
    }

    await this.writeRawFile(loaded.location, loaded.data);
    return true;
  }
}

function generateCommentId(
  type: CommentType,
  startLine: number,
  endLine: number
): string {
  const rand = Math.random().toString(36).slice(2, 7);
  return `${type}-${startLine}-${endLine}-${rand}`;
}

function normalizeEntry(
  entry: RawCommentEntry,
  index: number,
  document: vscode.TextDocument
): NormalizedComment {
  const maxLine = Math.max(1, document.lineCount);
  const rawStart = Math.max(1, Math.floor(entry.startLine ?? entry.line ?? 1));
  const rawEnd = Math.max(
    rawStart,
    Math.floor(entry.endLine ?? entry.startLine ?? entry.line ?? rawStart)
  );

  const type: CommentType =
    entry.type === "line" || entry.type === "block"
      ? entry.type
      : rawEnd > rawStart
      ? "block"
      : "line";

  const clampedStart = Math.min(rawStart, maxLine);
  const clampedEnd = type === "line" ? clampedStart : Math.max(clampedStart, Math.min(rawEnd, maxLine));

  const { adjustedStart, adjustedEnd, isStale } = adjustLinesWithAnchor(
    document,
    clampedStart,
    clampedEnd,
    entry.anchorText
  );

  const category: CommentCategory =
    entry.category && VALID_CATEGORIES.has(entry.category)
      ? entry.category
      : "explain";

  const id =
    entry.id && entry.id.trim().length > 0
      ? entry.id.trim()
      : `c_${index}_${type}_${rawStart}_${rawEnd}`;

  return {
    id,
    type,
    startLine: adjustedStart,
    endLine: type === "line" ? adjustedStart : adjustedEnd,
    originalStartLine: rawStart,
    originalEndLine: rawEnd,
    title: entry.title?.trim() || undefined,
    comment: entry.comment.trim(),
    category,
    anchorText: entry.anchorText,
    isStale,
    updatedAt: entry.updatedAt,
  };
}

function adjustLinesWithAnchor(
  document: vscode.TextDocument,
  startLine: number,
  endLine: number,
  anchorText?: string
): { adjustedStart: number; adjustedEnd: number; isStale: boolean } {
  const needle = anchorText?.trim();
  if (!needle || needle.length < 4) {
    return { adjustedStart: startLine, adjustedEnd: endLine, isStale: false };
  }

  const baseIdx = startLine - 1;
  if (document.lineAt(baseIdx).text.includes(needle)) {
    return { adjustedStart: startLine, adjustedEnd: endLine, isStale: false };
  }

  const maxSearchRadius = 30;
  for (let delta = 1; delta <= maxSearchRadius; delta++) {
    const upIdx = baseIdx - delta;
    if (upIdx >= 0 && document.lineAt(upIdx).text.includes(needle)) {
      const shift = upIdx + 1 - startLine;
      const newStart = upIdx + 1;
      const newEnd = Math.max(
        newStart,
        Math.min(endLine + shift, document.lineCount)
      );
      return { adjustedStart: newStart, adjustedEnd: newEnd, isStale: false };
    }

    const downIdx = baseIdx + delta;
    if (downIdx < document.lineCount && document.lineAt(downIdx).text.includes(needle)) {
      const shift = downIdx + 1 - startLine;
      const newStart = downIdx + 1;
      const newEnd = Math.max(
        newStart,
        Math.min(endLine + shift, document.lineCount)
      );
      return { adjustedStart: newStart, adjustedEnd: newEnd, isStale: false };
    }
  }

  return { adjustedStart: startLine, adjustedEnd: endLine, isStale: true };
}

export function getLineCommentsForLine(
  comments: NormalizedComment[],
  line1Based: number
): NormalizedComment[] {
  return comments.filter(
    (c) => c.type === "line" && c.startLine === line1Based
  );
}

export function getBlockCommentsStartingAtLine(
  comments: NormalizedComment[],
  line1Based: number
): NormalizedComment[] {
  return comments
    .filter((c) => c.type === "block" && c.startLine === line1Based)
    .sort((a, b) => {
      const spanA = a.endLine - a.startLine;
      const spanB = b.endLine - b.startLine;
      if (spanB !== spanA) {
        return spanB - spanA; // Outermost first
      }
      return a.id.localeCompare(b.id);
    });
}

export function getEnclosingBlockCommentsForLine(
  comments: NormalizedComment[],
  line1Based: number
): NormalizedComment[] {
  return comments
    .filter(
      (c) =>
        c.type === "block" &&
        c.startLine <= line1Based &&
        c.endLine >= line1Based
    )
    .sort((a, b) => {
      const spanA = a.endLine - a.startLine;
      const spanB = b.endLine - b.startLine;
      if (spanA !== spanB) {
        return spanA - spanB; // Innermost first
      }
      return b.startLine - a.startLine;
    });
}

export function summarizeToSingleLine(text: string, maxLength: number): string {
  const flattened = text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (flattened.length <= maxLength) {
    return flattened;
  }
  return flattened.slice(0, Math.max(10, maxLength - 1)).trimEnd() + "…";
}
