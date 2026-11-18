import * as vscode from "vscode";
import {
  getCategoryIcon,
  getExtensionConfig,
  SidecarStorage,
  summarizeToSingleLine,
} from "./storage";
import { NormalizedComment } from "./types";

export interface ShowCommentDetailArgs {
  documentUri: string;
  commentId?: string;
  isSummary?: boolean;
}

export class ExplainCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(private readonly storage: SidecarStorage) {}

  public refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  public async provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    const config = getExtensionConfig();
    if (config.displayMode !== "all" && config.displayMode !== "inlineOnly") {
      return [];
    }

    const data =
      this.storage.getCachedForDocument(document.uri) ??
      (await this.storage.loadForDocument(document));
    if (!data) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];

    if (data.summary && data.summary.length > 0) {
      const topRange = new vscode.Range(0, 0, 0, 0);
      const args: ShowCommentDetailArgs = {
        documentUri: document.uri.toString(),
        isSummary: true,
      };
      lenses.push(
        new vscode.CodeLens(topRange, {
          title: `📖 File Overview: ${summarizeToSingleLine(data.summary, 90)}`,
          tooltip: `${data.summary}\n\nClick to read full overview`,
          command: "aiExplainComments.showCommentDetail",
          arguments: [args],
        })
      );
    }

    const blocks = data.comments
      .filter((c) => c.type === "block")
      .sort((a, b) => {
        if (a.startLine !== b.startLine) {
          return a.startLine - b.startLine;
        }
        return (b.endLine - b.startLine) - (a.endLine - a.startLine);
      });

    for (const block of blocks) {
      const lineIdx = Math.max(
        0,
        Math.min(block.startLine - 1, Math.max(0, document.lineCount - 1))
      );
      const range = new vscode.Range(lineIdx, 0, lineIdx, 0);
      const args: ShowCommentDetailArgs = {
        documentUri: document.uri.toString(),
        commentId: block.id,
      };

      lenses.push(
        new vscode.CodeLens(range, {
          title: formatBlockLensTitle(block),
          tooltip: buildBlockTooltip(block),
          command: "aiExplainComments.showCommentDetail",
          arguments: [args],
        })
      );
    }

    return lenses;
  }
}

function formatBlockLensTitle(block: NormalizedComment): string {
  const icon = getCategoryIcon(block.category);
  const stale = block.isStale ? " [stale]" : "";
  const rangeLabel = `Lines ${block.startLine}–${block.endLine}`;
  const headline = block.title
    ? `${block.title} — ${summarizeToSingleLine(block.comment, 65)}`
    : summarizeToSingleLine(block.comment, 85);

  return `📦 ${icon} [${rangeLabel}${stale}] ${headline}`;
}

function buildBlockTooltip(block: NormalizedComment): string {
  const header = block.title
    ? `${block.title} (Lines ${block.startLine}–${block.endLine})`
    : `Block Lines ${block.startLine}–${block.endLine}`;
  return `${header}\n\n${block.comment}\n\nClick to focus/expand explanation`;
}
