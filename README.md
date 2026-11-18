# AI Explain Code Comments (Sidecar)

Speed up code review by letting AI agents (and developers) attach **line-level (`//`)** and **block-level** explanation comments to any part of a code file **without adding comments into the source file**.

All explanations are stored cleanly in sidecar JSON files under `.ai-review/<relative-file-path>.comments.json` in your workspace and are automatically loaded and live-reloaded when you open or review code files.

## Key Features

- **Clean Source Files**: Zero `//` or `/* */` noise added to your code files.
- **Simultaneous Line + Block Explanations**:
  - **Line comments (`type: "line"`)** render as inline ghost `// 💡 ...` annotations at the end of the line (without shifting code lines vertically), plus rich Markdown on hover.
  - **Block comments (`type: "block"`)** render with subtle left-border range highlights (supporting nested inner/outer blocks) and a clickable `📦 [Lines X–Y]` CodeLens header above the block.
  - Hovering any line inside a block shows **both** that line's explanation and every enclosing block explanation (from innermost to outermost).
- **Native VS Code Comment Threads**: Collapsed by default so lines don't jump apart; expand individual threads or run **Expand All Comment Threads** when you want full inline discussion boxes, or edit/reply/add directly from the gutter (`+`).
- **Live File Watcher**: As soon as an AI agent creates or updates a `.comments.json` file in `.ai-review/`, open editors update immediately.
- **Anchor Drift Tracking**: Optional `anchorText` lets comments follow lines automatically when code above them shifts by up to ±30 lines.

## Sidecar JSON Format

For `src/app/Example.cs`, create `.ai-review/src/app/Example.cs.comments.json`:

```json
{
  "version": 1,
  "targetFile": "src/app/Example.cs",
  "summary": "High-level overview of what this file does.",
  "comments": [
    {
      "id": "blk-init",
      "type": "block",
      "startLine": 41,
      "endLine": 63,
      "title": "Initialize form state from request",
      "category": "flow",
      "anchorText": "private void InitializeFromRequest()",
      "comment": "Resets child lists and populates the output model whenever a new request item is opened."
    },
    {
      "id": "line-fallback",
      "type": "line",
      "line": 53,
      "category": "business-rule",
      "anchorText": "FromBranchCode = RequestItem?.FromBranchCode",
      "comment": "Falls back to the signed-in user's branch when creating without a source request."
    }
  ]
}
```

## Display Modes

Click the status bar item (`AI Explain: ...`) or run `AI Explain: Switch Display Mode` to cycle between:
1. `all`: Inline `//` ghost comments + Block highlights + Block CodeLens + Hover + Collapsed native comment threads.
2. `inlineOnly`: Inline `//` ghost comments + Block highlights + Block CodeLens + Hover (no native threads).
3. `threadsOnly`: Native VS Code comment threads + Block highlights.
4. `off`: Temporarily hide all sidecar annotations.
