import * as vscode from "vscode";
import {
  getCategoryIcon,
  getExtensionConfig,
  summarizeToSingleLine,
} from "./storage";
import { LoadedSidecarData, NormalizedComment } from "./types";

export class DecorationManager implements vscode.Disposable {
  private readonly inlineLineDecoration: vscode.TextEditorDecorationType;
  private readonly outerBlockDecoration: vscode.TextEditorDecorationType;
  private readonly innerBlockDecoration: vscode.TextEditorDecorationType;

  constructor() {
    this.inlineLineDecoration = vscode.window.createTextEditorDecorationType({
      after: {
        margin: "0 0 0 2.5ch",
        fontStyle: "italic",
        color: new vscode.ThemeColor("editorCodeLens.foreground"),
      },
    });

    this.outerBlockDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: "0 0 0 2px",
      borderStyle: "solid",
      borderColor: "rgba(78, 201, 176, 0.55)",
      backgroundColor: "rgba(78, 201, 176, 0.04)",
    });

    this.innerBlockDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: "0 0 0 3px",
      borderStyle: "solid",
      borderColor: "rgba(86, 156, 214, 0.70)",
      backgroundColor: "rgba(86, 156, 214, 0.065)",
    });
  }

  public applyDecorations(
    editor: vscode.TextEditor,
    data: LoadedSidecarData | undefined
  ): void {
    const config = getExtensionConfig();
    if (!data || config.displayMode === "off") {
      this.clearDecorations(editor);
      return;
    }

    const doc = editor.document;
    const inlineOptions: vscode.DecorationOptions[] = [];
    const outerBlockRanges: vscode.Range[] = [];
    const innerBlockRanges: vscode.Range[] = [];

    const blockComments = data.comments.filter((c) => c.type === "block");
    for (const block of blockComments) {
      const startIdx = clampLineIdx(block.startLine - 1, doc.lineCount);
      const endIdx = clampLineIdx(block.endLine - 1, doc.lineCount);
      const range = new vscode.Range(startIdx, 0, endIdx, 0);

      const depth = computeBlockNestingDepth(block, blockComments);
      if (depth % 2 === 0) {
        outerBlockRanges.push(range);
      } else {
        innerBlockRanges.push(range);
      }
    }

    if (config.displayMode === "all" || config.displayMode === "inlineOnly") {
      const linesByNumber = new Map<number, NormalizedComment[]>();
      for (const c of data.comments) {
        if (c.type !== "line") {
          continue;
        }
        const list = linesByNumber.get(c.startLine) ?? [];
        list.push(c);
        linesByNumber.set(c.startLine, list);
      }

      for (const [lineNum, entries] of linesByNumber.entries()) {
        const lineIdx = clampLineIdx(lineNum - 1, doc.lineCount);
        const lineLength = doc.lineAt(lineIdx).text.length;
        const range = new vscode.Range(lineIdx, lineLength, lineIdx, lineLength);

        const joined = entries
          .map((e) => {
            const icon = getCategoryIcon(e.category);
            const staleTag = e.isStale ? "[stale] " : "";
            const prefix = e.title ? `${e.title}: ` : "";
            return `${icon} ${staleTag}${prefix}${e.comment}`;
          })
          .join(" | ");

        const contentText = `// ${summarizeToSingleLine(
          joined,
          config.inlineMaxLength
        )}`;

        inlineOptions.push({
          range,
          renderOptions: {
            after: {
              contentText,
            },
          },
        });
      }
    }

    editor.setDecorations(this.inlineLineDecoration, inlineOptions);
    editor.setDecorations(this.outerBlockDecoration, outerBlockRanges);
    editor.setDecorations(this.innerBlockDecoration, innerBlockRanges);
  }

  public clearDecorations(editor: vscode.TextEditor): void {
    editor.setDecorations(this.inlineLineDecoration, []);
    editor.setDecorations(this.outerBlockDecoration, []);
    editor.setDecorations(this.innerBlockDecoration, []);
  }

  public dispose(): void {
    this.inlineLineDecoration.dispose();
    this.outerBlockDecoration.dispose();
    this.innerBlockDecoration.dispose();
  }
}

function clampLineIdx(idx: number, lineCount: number): number {
  return Math.max(0, Math.min(idx, Math.max(0, lineCount - 1)));
}

function computeBlockNestingDepth(
  target: NormalizedComment,
  allBlocks: NormalizedComment[]
): number {
  const targetSpan = target.endLine - target.startLine;
  let depth = 0;
  for (const other of allBlocks) {
    if (other.id === target.id) {
      continue;
    }
    const otherSpan = other.endLine - other.startLine;
    if (
      other.startLine <= target.startLine &&
      other.endLine >= target.endLine &&
      otherSpan > targetSpan
    ) {
      depth++;
    }
  }
  return depth;
}
