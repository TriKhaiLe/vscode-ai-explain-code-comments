import * as vscode from "vscode";
import {
  getCategoryIcon,
  getCategoryLabel,
  getExtensionConfig,
  isSidecarOrIgnoredUri,
  resolveSidecarLocation,
  SidecarStorage,
} from "./storage";
import { LoadedSidecarData, NormalizedComment } from "./types";

export class ExplainCommentItem implements vscode.Comment {
  public readonly id: string;
  public readonly body: vscode.MarkdownString;
  public readonly mode = vscode.CommentMode.Preview;
  public readonly author: vscode.CommentAuthorInformation;
  public readonly contextValue = "aiExplainComment";
  public parent?: vscode.CommentThread;

  constructor(comment: NormalizedComment) {
    this.id = comment.id;
    const icon = getCategoryIcon(comment.category);
    const catLabel = getCategoryLabel(comment.category);
    const typeLabel = comment.type === "block" ? "Block" : "Line";

    this.author = {
      name: `${icon} AI ${typeLabel} · ${catLabel}`,
    };

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    if (comment.title) {
      md.appendMarkdown(`**${comment.title}**\n\n`);
    }
    if (comment.isStale) {
      md.appendMarkdown(
        `> ⚠ *Anchor text did not match near line ${comment.originalStartLine}; location may be approximate.*\n\n`
      );
    }
    md.appendMarkdown(comment.comment);
    this.body = md;
  }
}

export class ExplainCommentController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly threadsByDoc = new Map<
    string,
    Map<string, vscode.CommentThread>
  >();

  constructor(private readonly storage: SidecarStorage) {
    this.controller = vscode.comments.createCommentController(
      "ai-explain-comments",
      "AI Code Explanations"
    );
    this.controller.options = {
      prompt: "Add a line or block explanation...",
      placeHolder:
        "Explain this line or block (stored in .ai-review/, never added to the source code)",
    };

    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document: vscode.TextDocument) => {
        const config = getExtensionConfig();
        if (
          config.displayMode === "off" ||
          isSidecarOrIgnoredUri(document.uri, config.storageFolder)
        ) {
          return [];
        }
        if (!resolveSidecarLocation(document.uri)) {
          return [];
        }
        const lastLine = Math.max(0, document.lineCount - 1);
        return [new vscode.Range(0, 0, lastLine, 0)];
      },
    };
  }

  public syncDocument(
    document: vscode.TextDocument,
    data: LoadedSidecarData | undefined
  ): void {
    const docKey = document.uri.toString();
    const config = getExtensionConfig();

    if (
      !data ||
      data.comments.length === 0 ||
      config.displayMode === "off" ||
      config.displayMode === "inlineOnly"
    ) {
      this.clearDocument(docKey);
      return;
    }

    let docThreads = this.threadsByDoc.get(docKey);
    if (!docThreads) {
      docThreads = new Map<string, vscode.CommentThread>();
      this.threadsByDoc.set(docKey, docThreads);
    }

    const defaultCollapsible =
      config.expandThreadsByDefault || config.displayMode === "threadsOnly"
        ? vscode.CommentThreadCollapsibleState.Expanded
        : vscode.CommentThreadCollapsibleState.Collapsed;

    const activeIds = new Set<string>();

    for (const comment of data.comments) {
      activeIds.add(comment.id);
      const range = buildCommentRange(document, comment);
      const label = buildThreadLabel(comment);
      const item = new ExplainCommentItem(comment);

      const existing = docThreads.get(comment.id);
      if (existing) {
        existing.range = range;
        existing.label = label;
        item.parent = existing;
        existing.comments = [item];
      } else {
        const thread = this.controller.createCommentThread(
          document.uri,
          range,
          [item]
        );
        thread.canReply = false;
        thread.label = label;
        thread.collapsibleState = defaultCollapsible;
        item.parent = thread;
        docThreads.set(comment.id, thread);
      }
    }

    for (const [id, thread] of docThreads.entries()) {
      if (!activeIds.has(id)) {
        thread.dispose();
        docThreads.delete(id);
      }
    }
  }

  public setAllExpanded(documentUri: vscode.Uri, expanded: boolean): number {
    const docThreads = this.threadsByDoc.get(documentUri.toString());
    if (!docThreads) {
      return 0;
    }
    const targetState = expanded
      ? vscode.CommentThreadCollapsibleState.Expanded
      : vscode.CommentThreadCollapsibleState.Collapsed;
    let count = 0;
    for (const thread of docThreads.values()) {
      thread.collapsibleState = targetState;
      count++;
    }
    return count;
  }

  public expandThread(documentUri: vscode.Uri, commentId: string): boolean {
    const docThreads = this.threadsByDoc.get(documentUri.toString());
    const thread = docThreads?.get(commentId);
    if (!thread) {
      return false;
    }
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    return true;
  }

  public clearDocument(docUriString: string): void {
    const docThreads = this.threadsByDoc.get(docUriString);
    if (!docThreads) {
      return;
    }
    for (const thread of docThreads.values()) {
      thread.dispose();
    }
    docThreads.clear();
    this.threadsByDoc.delete(docUriString);
  }

  public clearAll(): void {
    for (const docThreads of this.threadsByDoc.values()) {
      for (const thread of docThreads.values()) {
        thread.dispose();
      }
      docThreads.clear();
    }
    this.threadsByDoc.clear();
  }

  public async handleCreateReply(reply: vscode.CommentReply): Promise<boolean> {
    const thread = reply.thread;
    const text = reply.text.trim();
    if (!text) {
      return false;
    }

    const doc = await vscode.workspace.openTextDocument(thread.uri);
    const range = thread.range;
    const startLine = (range?.start.line ?? 0) + 1;
    const endLine = Math.max(startLine, (range?.end.line ?? startLine - 1) + 1);

    await this.storage.addComment(doc, {
      type: endLine > startLine ? "block" : "line",
      startLine,
      endLine,
      comment: text,
      category: "explain",
    });

    // Dispose the temporary placeholder thread created by VS Code; reload will recreate the canonical one
    thread.dispose();
    return true;
  }

  public dispose(): void {
    this.clearAll();
    this.controller.dispose();
  }
}

function buildCommentRange(
  document: vscode.TextDocument,
  comment: NormalizedComment
): vscode.Range {
  const maxLine = Math.max(0, document.lineCount - 1);
  const startIdx = Math.max(0, Math.min(comment.startLine - 1, maxLine));
  const endIdx = Math.max(startIdx, Math.min(comment.endLine - 1, maxLine));
  const endCol = document.lineAt(endIdx).text.length;
  return new vscode.Range(startIdx, 0, endIdx, endCol);
}

function buildThreadLabel(comment: NormalizedComment): string {
  const icon = getCategoryIcon(comment.category);
  if (comment.type === "block") {
    const titlePart = comment.title ? `: ${comment.title}` : "";
    return `📦 ${icon} Block Lines ${comment.startLine}–${comment.endLine}${titlePart}`;
  }
  const titlePart = comment.title ? `: ${comment.title}` : "";
  return `${icon} Line ${comment.startLine}${titlePart}`;
}
