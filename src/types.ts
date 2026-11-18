import * as vscode from "vscode";

export type CommentType = "line" | "block";

export type CommentCategory =
  | "explain"
  | "flow"
  | "business-rule"
  | "warning"
  | "note";

export type DisplayMode = "all" | "inlineOnly" | "threadsOnly" | "off";

export interface RawCommentEntry {
  id?: string;
  type?: CommentType;
  line?: number;
  startLine?: number;
  endLine?: number;
  title?: string;
  comment: string;
  category?: CommentCategory;
  anchorText?: string;
  updatedAt?: string;
}

export interface SidecarCommentFile {
  version: number;
  targetFile: string;
  summary?: string;
  updatedAt?: string;
  comments: RawCommentEntry[];
}

export interface NormalizedComment {
  id: string;
  type: CommentType;
  startLine: number;
  endLine: number;
  originalStartLine: number;
  originalEndLine: number;
  title?: string;
  comment: string;
  category: CommentCategory;
  anchorText?: string;
  isStale: boolean;
  updatedAt?: string;
}

export interface LoadedSidecarData {
  sidecarUri: vscode.Uri;
  workspaceFolder?: vscode.WorkspaceFolder;
  targetFile: string;
  summary?: string;
  updatedAt?: string;
  comments: NormalizedComment[];
}

export interface ExtensionConfig {
  storageFolder: string;
  displayMode: DisplayMode;
  inlineMaxLength: number;
  expandThreadsByDefault: boolean;
}
