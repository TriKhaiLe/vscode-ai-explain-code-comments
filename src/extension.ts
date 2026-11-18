import * as vscode from "vscode";
import {
  ExplainCodeLensProvider,
  ShowCommentDetailArgs,
} from "./codelensProvider";
import {
  ExplainCommentController,
  ExplainCommentItem,
} from "./commentController";
import { DecorationManager } from "./decorationManager";
import { ExplainHoverProvider } from "./hoverProvider";
import {
  getExtensionConfig,
  isSidecarOrIgnoredUri,
  resolveSidecarLocation,
  SidecarStorage,
} from "./storage";
import { CommentCategory, DisplayMode } from "./types";

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel(
    "AI Explain Code Comments"
  );
  outputChannel.appendLine("[AI Explain] Extension activated.");
  console.log("[AI Explain] Extension activated.");

  const storage = new SidecarStorage();
  const decorationManager = new DecorationManager();
  const codeLensProvider = new ExplainCodeLensProvider(storage);
  const hoverProvider = new ExplainHoverProvider(storage);
  const commentController = new ExplainCommentController(storage);

  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "aiExplainComments.toggleDisplayMode";

  const docSelector: vscode.DocumentSelector = { scheme: "file" };

  context.subscriptions.push(
    outputChannel,
    decorationManager,
    commentController,
    statusBarItem,
    vscode.languages.registerCodeLensProvider(docSelector, codeLensProvider),
    vscode.languages.registerHoverProvider(docSelector, hoverProvider)
  );

  const updateStatusBar = (editor: vscode.TextEditor | undefined): void => {
    if (!editor) {
      statusBarItem.hide();
      return;
    }
    const config = getExtensionConfig();
    if (isSidecarOrIgnoredUri(editor.document.uri, config.storageFolder)) {
      statusBarItem.hide();
      return;
    }
    const location = resolveSidecarLocation(editor.document.uri);
    if (!location) {
      statusBarItem.hide();
      return;
    }

    const data = storage.getCachedForDocument(editor.document.uri);
    const total = data?.comments.length ?? 0;
    const blockCount =
      data?.comments.filter((c) => c.type === "block").length ?? 0;
    const lineCount =
      data?.comments.filter((c) => c.type === "line").length ?? 0;

    const modeLabel = formatModeShort(config.displayMode);
    statusBarItem.text =
      total > 0
        ? `$(book) AI Explain: ${blockCount}B / ${lineCount}L [${modeLabel}]`
        : `$(book) AI Explain: 0 [${modeLabel}]`;
    statusBarItem.tooltip =
      total > 0
        ? `${blockCount} block explanation(s), ${lineCount} line explanation(s)\nSidecar: ${config.storageFolder}/${location.targetFile}.comments.json\nClick to switch display mode`
        : `No sidecar explanations yet for ${location.targetFile}\nClick to switch display mode`;
    statusBarItem.show();
  };

  const syncEditor = async (editor: vscode.TextEditor): Promise<void> => {
    const config = getExtensionConfig();
    if (isSidecarOrIgnoredUri(editor.document.uri, config.storageFolder)) {
      decorationManager.clearDecorations(editor);
      updateStatusBar(editor);
      return;
    }

    try {
      const data = await storage.loadForDocument(editor.document);
      if (data) {
        outputChannel.appendLine(
          `[AI Explain] Loaded ${data.comments.length} comment(s) from ${data.sidecarUri.fsPath}`
        );
      }
      decorationManager.applyDecorations(editor, data);
      commentController.syncDocument(editor.document, data);
    } catch (err) {
      outputChannel.appendLine(`[AI Explain] syncEditor error: ${String(err)}`);
      console.error("AI Explain syncEditor error:", err);
    }
    updateStatusBar(editor);
  };

  const syncAllVisibleEditors = async (): Promise<void> => {
    const editors = vscode.window.visibleTextEditors;
    await Promise.all(editors.map((e) => syncEditor(e)));
    codeLensProvider.refresh();
    updateStatusBar(vscode.window.activeTextEditor);
  };

  // Initial sync for already-open editors
  void syncAllVisibleEditors();

  // Editor & document lifecycle listeners
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        void syncEditor(editor);
      } else {
        updateStatusBar(undefined);
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) {
        void syncEditor(editor);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      commentController.clearDocument(doc.uri.toString());
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("aiExplainComments")) {
        storage.clearAllCache();
        void syncAllVisibleEditors();
      }
    })
  );

  // Debounced refresh on source text edits so anchor drift & end-of-line positions stay accurate
  let editTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const config = getExtensionConfig();
      if (isSidecarOrIgnoredUri(e.document.uri, config.storageFolder)) {
        return;
      }
      if (!storage.getCachedForDocument(e.document.uri)) {
        return;
      }
      if (editTimer) {
        clearTimeout(editTimer);
      }
      editTimer = setTimeout(() => {
        const matchingEditors = vscode.window.visibleTextEditors.filter(
          (ed) => ed.document.uri.toString() === e.document.uri.toString()
        );
        for (const ed of matchingEditors) {
          void syncEditor(ed);
        }
        codeLensProvider.refresh();
      }, 250);
    })
  );

  // Live file watcher for AI-generated/edited sidecar files
  const sidecarWatcher =
    vscode.workspace.createFileSystemWatcher("**/*.comments.json");
  const onSidecarFileChanged = (uri: vscode.Uri): void => {
    storage.clearCacheForSidecar(uri);
    void syncAllVisibleEditors();
  };
  sidecarWatcher.onDidCreate(onSidecarFileChanged);
  sidecarWatcher.onDidChange(onSidecarFileChanged);
  sidecarWatcher.onDidDelete(onSidecarFileChanged);
  context.subscriptions.push(sidecarWatcher);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "aiExplainComments.toggleDisplayMode",
      async () => {
        const current = getExtensionConfig().displayMode;
        const picks: Array<vscode.QuickPickItem & { mode: DisplayMode }> = [
          {
            label: "$(eye) All (Inline // + Block Highlights + CodeLens + Collapsed Threads)",
            description: current === "all" ? "Current" : undefined,
            mode: "all",
          },
          {
            label: "$(code) Inline // + Block Highlights + CodeLens + Hover only",
            description: current === "inlineOnly" ? "Current" : undefined,
            mode: "inlineOnly",
          },
          {
            label: "$(comment-discussion) Native Comment Threads + Block Highlights only",
            description: current === "threadsOnly" ? "Current" : undefined,
            mode: "threadsOnly",
          },
          {
            label: "$(eye-closed) Off (Hide all sidecar explanations)",
            description: current === "off" ? "Current" : undefined,
            mode: "off",
          },
        ];

        const picked = await vscode.window.showQuickPick(picks, {
          placeHolder: "Select how AI explanation comments are displayed",
        });
        if (!picked) {
          return;
        }
        await vscode.workspace
          .getConfiguration("aiExplainComments")
          .update("displayMode", picked.mode, vscode.ConfigurationTarget.Workspace);
        await syncAllVisibleEditors();
      }
    ),

    vscode.commands.registerCommand(
      "aiExplainComments.expandAllThreads",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          return;
        }
        const config = getExtensionConfig();
        if (config.displayMode === "inlineOnly" || config.displayMode === "off") {
          await vscode.workspace
            .getConfiguration("aiExplainComments")
            .update("displayMode", "all", vscode.ConfigurationTarget.Workspace);
          await syncEditor(editor);
        }
        const count = commentController.setAllExpanded(editor.document.uri, true);
        if (count === 0) {
          void vscode.window.showInformationMessage(
            "AI Explain: No comment threads in the current file."
          );
        }
      }
    ),

    vscode.commands.registerCommand(
      "aiExplainComments.collapseAllThreads",
      () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          return;
        }
        commentController.setAllExpanded(editor.document.uri, false);
      }
    ),

    vscode.commands.registerCommand("aiExplainComments.addComment", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const config = getExtensionConfig();
      if (isSidecarOrIgnoredUri(editor.document.uri, config.storageFolder)) {
        void vscode.window.showInformationMessage(
          "AI Explain: Open a source code file (not a .comments.json file) to add an explanation."
        );
        return;
      }

      const sel = editor.selection;
      const startLine = sel.start.line + 1;
      let endLine = sel.end.line + 1;
      if (!sel.isEmpty && sel.end.character === 0 && endLine > startLine) {
        endLine -= 1;
      }
      const isBlock = endLine > startLine;

      const categoryPick = await vscode.window.showQuickPick<
        vscode.QuickPickItem & { value: CommentCategory }
      >(
        [
          { label: "💡 Explain", description: "General explanation of what this code does", value: "explain" },
          { label: "🔀 Flow", description: "Control flow, lifecycle, or sequence", value: "flow" },
          { label: "📋 Business Rule", description: "Domain / business logic requirement", value: "business-rule" },
          { label: "⚠️ Warning", description: "Edge case, side effect, or gotcha", value: "warning" },
          { label: "📝 Note", description: "Reviewer note or reminder", value: "note" },
        ],
        {
          placeHolder: isBlock
            ? `Adding BLOCK explanation for Lines ${startLine}–${endLine}`
            : `Adding LINE explanation for Line ${startLine}`,
        }
      );
      if (!categoryPick) {
        return;
      }

      let title: string | undefined;
      if (isBlock) {
        const inputTitle = await vscode.window.showInputBox({
          prompt: `Optional short title for Block Lines ${startLine}–${endLine}`,
          placeHolder: "e.g. Initialize form defaults from request",
        });
        if (inputTitle === undefined) {
          return;
        }
        title = inputTitle.trim() || undefined;
      }

      const commentText = await vscode.window.showInputBox({
        prompt: isBlock
          ? `Explanation for Block Lines ${startLine}–${endLine}`
          : `Explanation for Line ${startLine}`,
        placeHolder: "Describe why/how this code works...",
        validateInput: (v) =>
          v.trim().length === 0 ? "Explanation cannot be empty." : undefined,
      });
      if (!commentText) {
        return;
      }

      await storage.addComment(editor.document, {
        type: isBlock ? "block" : "line",
        ...(isBlock ? { startLine, endLine } : { line: startLine }),
        title,
        category: categoryPick.value,
        comment: commentText,
      });

      await syncEditor(editor);
      codeLensProvider.refresh();
    }),

    vscode.commands.registerCommand(
      "aiExplainComments.openSidecarFile",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          return;
        }
        const location = resolveSidecarLocation(editor.document.uri);
        if (!location) {
          void vscode.window.showWarningMessage(
            "AI Explain: Current file is not inside a workspace folder or is already a sidecar file."
          );
          return;
        }

        const loaded = await storage.readOrInitRawFile(editor.document.uri);
        if (!loaded) {
          return;
        }
        await storage.writeRawFile(loaded.location, loaded.data);
        const doc = await vscode.workspace.openTextDocument(
          loaded.location.sidecarUri
        );
        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Beside,
          preview: false,
        });
      }
    ),

    vscode.commands.registerCommand(
      "aiExplainComments.copyAgentPrompt",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          return;
        }
        const config = getExtensionConfig();
        const location = resolveSidecarLocation(editor.document.uri);
        if (!location) {
          void vscode.window.showWarningMessage(
            "AI Explain: Open a workspace source file first."
          );
          return;
        }

        const sidecarRelPath = `${config.storageFolder}/${location.targetFile}.comments.json`;
        const promptText = [
          `Read \`${location.targetFile}\` and generate sidecar code explanation comments at \`${sidecarRelPath}\` (do NOT modify \`${location.targetFile}\`).`,
          "",
          "Requirements:",
          "- Create BOTH `block` comments (for methods, logical sections, and important inner blocks) AND `line` comments (for non-obvious expressions, guards, fallbacks, or math inside those blocks).",
          "- Include `anchorText` (exact short substring from `startLine` or `line`) on each entry so line numbers auto-adjust on minor edits.",
          "- Use JSON format `{ \"version\": 1, \"targetFile\": \"...\", \"summary\": \"...\", \"comments\": [ ... ] }`.",
        ].join("\n");

        await vscode.env.clipboard.writeText(promptText);
        void vscode.window.showInformationMessage(
          `AI Explain: Copied AI prompt for ${location.targetFile} to clipboard.`
        );
      }
    ),

    vscode.commands.registerCommand("aiExplainComments.refresh", async () => {
      storage.clearAllCache();
      await syncAllVisibleEditors();
    }),

    vscode.commands.registerCommand(
      "aiExplainComments.showCommentDetail",
      async (args?: ShowCommentDetailArgs) => {
        if (!args?.documentUri) {
          return;
        }
        const targetUri = vscode.Uri.parse(args.documentUri);
        const editor = vscode.window.visibleTextEditors.find(
          (e) => e.document.uri.toString() === args.documentUri
        );
        const data = storage.getCachedForDocument(targetUri);
        if (!data) {
          return;
        }

        if (args.isSummary) {
          if (data.summary) {
            const action = await vscode.window.showInformationMessage(
              `File Overview — ${data.targetFile}`,
              { modal: true, detail: data.summary },
              "Open Sidecar JSON"
            );
            if (action === "Open Sidecar JSON") {
              await vscode.commands.executeCommand(
                "aiExplainComments.openSidecarFile"
              );
            }
          }
          return;
        }

        if (!args.commentId) {
          return;
        }
        const comment = data.comments.find((c) => c.id === args.commentId);
        if (!comment) {
          return;
        }

        if (editor) {
          const startPos = new vscode.Position(
            Math.max(0, comment.startLine - 1),
            0
          );
          const endLineIdx = Math.max(
            0,
            Math.min(comment.endLine - 1, editor.document.lineCount - 1)
          );
          const endPos = new vscode.Position(
            endLineIdx,
            editor.document.lineAt(endLineIdx).text.length
          );
          editor.selection = new vscode.Selection(startPos, endPos);
          editor.revealRange(
            new vscode.Range(startPos, endPos),
            vscode.TextEditorRevealType.InCenterIfOutsideViewport
          );
        }

        const config = getExtensionConfig();
        const expanded =
          config.displayMode === "all" || config.displayMode === "threadsOnly"
            ? commentController.expandThread(targetUri, comment.id)
            : false;

        if (!expanded) {
          const header = comment.title
            ? `${comment.title} (Lines ${comment.startLine}–${comment.endLine})`
            : `Lines ${comment.startLine}–${comment.endLine}`;
          const action = await vscode.window.showInformationMessage(
            header,
            { modal: true, detail: comment.comment },
            "Open Sidecar JSON"
          );
          if (action === "Open Sidecar JSON") {
            await vscode.commands.executeCommand(
              "aiExplainComments.openSidecarFile"
            );
          }
        }
      }
    ),

    vscode.commands.registerCommand(
      "aiExplainComments.createThreadComment",
      async (reply: vscode.CommentReply) => {
        if (!reply) {
          return;
        }
        const ok = await commentController.handleCreateReply(reply);
        if (ok) {
          await syncAllVisibleEditors();
        }
      }
    ),

    vscode.commands.registerCommand(
      "aiExplainComments.deleteThreadComment",
      async (comment: ExplainCommentItem) => {
        if (!comment?.parent) {
          return;
        }
        const deleted = await storage.deleteComment(
          comment.parent.uri,
          comment.id
        );
        if (deleted) {
          await syncAllVisibleEditors();
        }
      }
    )
  );
}

export function deactivate(): void {
  // All disposables are cleaned up via context.subscriptions
}

function formatModeShort(mode: DisplayMode): string {
  switch (mode) {
    case "all":
      return "All";
    case "inlineOnly":
      return "Inline";
    case "threadsOnly":
      return "Threads";
    case "off":
      return "Off";
  }
}
