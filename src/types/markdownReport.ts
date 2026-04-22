import type { ClassifiedFinding } from "./depauditConfig.js";

export const MARKDOWN_COMMENT_MARKER = "<!-- depaudit-gate-comment -->" as const;

export interface MarkdownReportOptions {
  suggestedActionFor?(cf: ClassifiedFinding): string;
}
