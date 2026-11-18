import * as vscode from "vscode";
import {
  getBlockCommentsStartingAtLine,
  getCategoryIcon,
  getCategoryLabel,
  getEnclosingBlockCommentsForLine,
  getExtensionConfig,
  getLineCommentsForLine,
  SidecarStorage,
} from "./storage";

export class ExplainHoverProvider implements vscode.HoverProvider {
  constructor(private readonly storage: SidecarStorage) {}

  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    const config = getExtensionConfig();
    if (config.displayMode === "off") {
      return undefined;
    }

    const data =
      this.storage.getCachedForDocument(document.uri) ??
      (await this.storage.loadForDocument(document));
    if (!data || data.comments.length === 0) {
      return undefined;
    }

    const line1Based = position.line + 1;
    const lineComments = getLineCommentsForLine(data.comments, line1Based);
    const enclosingBlocks = getEnclosingBlockCommentsForLine(
      data.comments,
      line1Based
    );

    if (lineComments.length === 0 && enclosingBlocks.length === 0) {
      return undefined;
    }

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.supportHtml = false;

    if (lineComments.length > 0) {
      for (const lc of lineComments) {
        const icon = getCategoryIcon(lc.category);
        const cat = getCategoryLabel(lc.category);
        const staleWarn = lc.isStale ? " *(⚠ anchor may be stale)*" : "";
        const titlePart = lc.title ? ` — **${lc.title}**` : "";
        md.appendMarkdown(
          `#### ${icon} Line ${line1Based} (${cat})${titlePart}${staleWarn}\n\n`
        );
        md.appendMarkdown(`${lc.comment}\n\n`);
      }
    }

    if (enclosingBlocks.length > 0) {
      if (lineComments.length > 0) {
        md.appendMarkdown(`---\n\n`);
      }

      for (let i = 0; i < enclosingBlocks.length; i++) {
        const blk = enclosingBlocks[i];
        const icon = getCategoryIcon(blk.category);
        const cat = getCategoryLabel(blk.category);
        const scopeTag =
          i === 0 && enclosingBlocks.length > 1
            ? " *(inner block)*"
            : i > 0
            ? " *(outer block)*"
            : "";
        const staleWarn = blk.isStale ? " *(⚠ anchor may be stale)*" : "";
        const titlePart = blk.title ? ` — **${blk.title}**` : "";

        md.appendMarkdown(
          `#### 📦 ${icon} Block Lines ${blk.startLine}–${blk.endLine} (${cat})${scopeTag}${titlePart}${staleWarn}\n\n`
        );
        md.appendMarkdown(`${blk.comment}\n\n`);
      }
    }

    md.appendMarkdown(
      `---\n[$(json) Open Sidecar JSON](command:aiExplainComments.openSidecarFile) · [$(add) Add Comment Here](command:aiExplainComments.addComment) · [$(comment-discussion) Switch Display Mode](command:aiExplainComments.toggleDisplayMode)`
    );

    const lineLength = document.lineAt(position.line).text.length;
    return new vscode.Hover(
      md,
      new vscode.Range(position.line, 0, position.line, lineLength)
    );
  }
}
