---
name: ai-explain-code
description: Generate clean, non-invasive line and block explanation comments for code review in `.ai-review/<relative-file-path>.comments.json` without modifying source code files. Use when the user asks to explain code for review, annotate a file with sidecar comments, or populate `.ai-review/` comments.
---

# AI Explain Code (Sidecar Comments)

Generate structured code-review explanations stored **outside** source files so code remains clean while reviewers get instant `//` inline comments, block range highlights, hover details, and collapsible comment threads via the `vscode-ai-explain-code-comments` VS Code extension.

## File Location Rules

1. **Never edit the target source file** just to add explanation comments.
2. Given a workspace root `<workspaceRoot>` and a target file `<relativePath>` (using forward slashes, e.g. `src/services/OrderService.cs`), write the sidecar JSON to:
   ```text
   <workspaceRoot>/.ai-review/<relativePath>.comments.json
   ```
3. Create parent directories under `.ai-review/` automatically as needed.

## Sidecar JSON Schema

```json
{
  "version": 1,
  "targetFile": "relative/path/to/SourceFile.cs",
  "summary": "1-3 sentence high-level overview of this file's responsibility and key workflow.",
  "comments": [
    {
      "id": "unique-short-id",
      "type": "block",
      "startLine": 30,
      "endLine": 39,
      "title": "Short block title",
      "category": "flow",
      "anchorText": "protected override void OnParametersSet()",
      "comment": "Explains what this whole block accomplishes and why it is structured this way."
    },
    {
      "id": "unique-line-id",
      "type": "line",
      "line": 32,
      "category": "business-rule",
      "anchorText": "if (Visible && (!wasVisible || lastRequestId != RequestItem?.Id))",
      "comment": "Re-initializes only when the popup transitions from closed->open or switches to a different RequestItem."
    }
  ]
}
```

### Field Reference

| Field | Required | Notes |
| --- | --- | --- |
| `id` | Recommended | Unique string per comment in the file. |
| `type` | Recommended | `"block"` for a multi-line region or `"line"` for a single line. |
| `startLine` / `endLine` | For `"block"` | 1-based inclusive line numbers matching the source file. |
| `line` | For `"line"` | 1-based line number (equivalent to `startLine`). |
| `title` | Recommended for `"block"` | Concise header shown in the block CodeLens and thread title. |
| `category` | Optional | One of `"explain"` (default), `"flow"`, `"business-rule"`, `"warning"`, `"note"`. |
| `anchorText` | Strongly recommended | Exact short code substring from `startLine` / `line` (>= 4 chars) so the extension can re-align comments automatically if lines shift later. |
| `comment` | Required | Concise, high-signal explanation focused on **why** and **intent**, not repeating syntax. Markdown supported. |

## Authoring Guidelines for Fast Code Review

1. **Layer blocks + lines together**:
   - Put `"block"` comments on classes/sections, methods, and non-trivial inner blocks (nested blocks are supported and visually distinguished).
   - Put `"line"` comments on specific lines *inside* those blocks whenever a condition, fallback, formula, magic value, or mutation pattern isn't obvious at a glance.
   - Keep `"line"` comments crisp (1 sentence ideally) so they read cleanly as end-of-line `//` annotations, while `"block"` comments can explain overall responsibility and side effects.
2. **Verify exact line numbers**: Always read the target file with line numbers before writing `.comments.json` so `line`, `startLine`, `endLine`, and `anchorText` match the real file.
3. **Preserve existing reviewer notes**: If `.comments.json` already exists, read it first and merge/update rather than blindly overwriting user-added notes unless asked to regenerate.
