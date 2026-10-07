export type Format = "srt" | "vtt";
export interface SubtitleCue {
  id: string;
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}
export type IssueType =
  | "overlap"
  | "too-short"
  | "gap-narrow"
  | "too-fast"
  | "too-long"
  | "empty"
  | "invalid-time";
export interface SubtitleIssue {
  /** 稳定标识：同一条目的同一问题在重新检测后保持一致，用于快照前后比对 */
  id: string;
  cueId: string;
  type: IssueType;
  severity: "info" | "warning" | "error";
  message: string;
}

export type FixKind = "invalid-time" | "overlap" | "gap-narrow" | "extend";
/** 一次原子时间改动：重设区间，或把从某条开始的后缀整体平移 */
export type FixAction =
  | { type: "set"; cueId: string; startMs?: number; endMs?: number }
  | { type: "ripple"; fromId: string; deltaMs: number };

export interface TimeRange {
  startMs: number;
  endMs: number;
}
export interface CueChange {
  cueId: string;
  index: number;
  before: TimeRange;
  after: TimeRange;
}
export interface ProposedFix {
  id: string;
  kind: FixKind;
  cueId: string;
  /** 该改法旨在消除的问题稳定 id（可能附带消除相邻的其它问题） */
  issueIds: string[];
  title: string;
  detail: string;
  changes: CueChange[];
  /** 可安全执行时为重放动作；放不下时为 null，问题保留 */
  actions: FixAction[] | null;
  blockedReason: string | null;
}
export interface UnsupportedIssue {
  issueId: string;
  cueId: string;
  index: number;
  kind: "empty" | "too-long";
  message: string;
  reason: string;
}
export interface AppliedFix {
  id: string;
  kind: FixKind;
  cueId: string;
  title: string;
  detail: string;
  actions: FixAction[];
  /** 执行前各受影响条目的区间，撤回时用于安全校验 */
  before: CueChange[];
  /** 这次修正（在完整计划中）顺带消除的问题，撤回时允许它们重新出现 */
  resolvedIssueIds: string[];
  undone?: boolean;
}
export interface SkippedFix {
  id: string;
  title: string;
  detail: string;
  reason: string;
}
export interface BatchFixState {
  /** 本次生成建议时所针对的检查结果 */
  planIssueIds: string[];
  fixes: AppliedFix[];
  skipped: SkippedFix[];
  unsupported: UnsupportedIssue[];
  /** 执行前自动保存的版本快照 */
  beforeVersionId: string;
  /** 执行后自动保存的版本快照 */
  afterVersionId: string;
  appliedAt: number;
}

export interface SubtitleProject {
  id: string;
  name: string;
  format: Format;
  cues: SubtitleCue[];
  updatedAt: number;
  versions: Array<{
    id: string;
    label: string;
    savedAt: number;
    cues: SubtitleCue[];
    /** 快照保存时的问题指纹，回退后用于确认检查结果一致 */
    issueIds?: string[];
    kind?: "manual" | "batch-before" | "batch-after";
  }>;
}
export interface MeterState {
  phase: "empty" | "importing" | "ready" | "editing" | "exporting" | "error";
  project: SubtitleProject | null;
  issues: SubtitleIssue[];
  selectedId: string | null;
  notice: string;
  zoom: number;
  batchFix: BatchFixState | null;
}
export const emptyState = (): MeterState => ({
  phase: "empty",
  project: null,
  issues: [],
  selectedId: null,
  notice: "",
  zoom: 1,
  batchFix: null,
});
