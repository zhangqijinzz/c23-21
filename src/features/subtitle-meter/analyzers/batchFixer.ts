import { countChars, RULES } from "../analyzers/issueDetector";
import type {
  CueChange,
  FixAction,
  FixKind,
  ProposedFix,
  SubtitleCue,
  SubtitleIssue,
  UnsupportedIssue,
} from "../models";

/** 无法自动处理的类型及原因，界面必须显式列出 */
export const UNSUPPORTED_REASONS = {
  empty: "需要补写或确认译文，无法凭空生成文本",
  "too-long": "需要人工精简或拆分文案，自动删改会改变原意",
} as const;

export interface BatchFixPlan {
  fixes: ProposedFix[];
  unsupported: UnsupportedIssue[];
}

const fmt = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(2)}s`;

/** 校验一个动作在给定时间轴上是否安全；安全则返回改动后的新数组 */
export function replayAction(
  cues: SubtitleCue[],
  action: FixAction,
  options: { inverse?: boolean } = {},
): SubtitleCue[] | null {
  const orderedIds = [...cues]
    .sort((a, b) => a.startMs - b.startMs)
    .map((cue) => cue.id);
  const byId = new Map(cues.map((cue) => [cue.id, cue]));
  const next = cues.map((cue) => ({ ...cue }));
  const setOf = (id: string) => next.find((cue) => cue.id === id);
  const rangeOf = (id: string) => {
    const pos = orderedIds.indexOf(id);
    return {
      prev: pos > 0 ? byId.get(orderedIds[pos - 1]) : undefined,
      next:
        pos >= 0 && pos < orderedIds.length - 1
          ? byId.get(orderedIds[pos + 1])
          : undefined,
    };
  };

  if (action.type === "set") {
    const cue = setOf(action.cueId);
    if (!cue) return null;
    const start = action.startMs ?? cue.startMs,
      end = action.endMs ?? cue.endMs;
    if (start < 0 || end < 0) return null;
    // 正向修正要求结束晚于开始且与相邻条目保持间隔；
    // 撤回只做非负校验，是否恢复了允许的问题由调用方的问题白名单把关
    if (!options.inverse) {
      if (end <= start) return null;
      const { prev, next: nxt } = rangeOf(action.cueId);
      if (prev && start < prev.endMs + RULES.minGapMs) return null;
      if (nxt && nxt.startMs < end + RULES.minGapMs) return null;
    }
    // 正向修正必须保住最短停留；撤回是恢复原状，允许短于下限
    if (!options.inverse && end - start < RULES.minDurationMs) return null;
    cue.startMs = start;
    cue.endMs = end;
    return next;
  }

  // ripple：把 fromId 及其后所有条目整体平移，链内间隔不变
  const from = byId.get(action.fromId);
  if (!from || action.deltaMs === 0) return null;
  const pos = orderedIds.indexOf(action.fromId);
  const prev = pos > 0 ? byId.get(orderedIds[pos - 1]) : undefined;
  if (
    !options.inverse &&
    prev &&
    from.startMs + action.deltaMs < prev.endMs + RULES.minGapMs
  )
    return null;
  for (const cue of next)
    if (orderedIds.indexOf(cue.id) >= pos) {
      cue.startMs += action.deltaMs;
      cue.endMs += action.deltaMs;
      if (cue.startMs < 0 || cue.endMs < 0) return null;
      // 正向修正保持时长为正；撤回允许恢复无效时间类原状（由调用方白名单把关）
      if (!options.inverse && cue.endMs <= cue.startMs) return null;
    }
  return next;
}

/** 按序重放动作序列；任一动作不安全则整体放弃（原子性） */
export function replayActions(
  cues: SubtitleCue[],
  actions: FixAction[],
  options: { inverse?: boolean } = {},
): SubtitleCue[] | null {
  let working = cues;
  for (const action of actions) {
    const result = replayAction(working, action, options);
    if (!result) return null;
    working = result;
  }
  return working;
}

export function changesBetween(
  before: SubtitleCue[],
  after: SubtitleCue[],
): CueChange[] {
  const beforeMap = new Map(before.map((cue) => [cue.id, cue]));
  const changes: CueChange[] = [];
  for (const cue of after) {
    const old = beforeMap.get(cue.id);
    if (old && (old.startMs !== cue.startMs || old.endMs !== cue.endMs))
      changes.push({
        cueId: cue.id,
        index: cue.index,
        before: { startMs: old.startMs, endMs: old.endMs },
        after: { startMs: cue.startMs, endMs: cue.endMs },
      });
  }
  return changes;
}

function describeChanges(changes: CueChange[]): string {
  return changes
    .map(
      (change) =>
        `#${change.index}：${fmt(change.before.startMs)}–${fmt(
          change.before.endMs,
        )} → ${fmt(change.after.startMs)}–${fmt(change.after.endMs)}`,
    )
    .join("；");
}

interface Planner {
  ordered: SubtitleCue[];
  proposals: ProposedFix[];
  seq: number;
  /** 工作副本的实时索引 */
  cue: (id: string) => SubtitleCue | undefined;
  neighbor: (id: string, offset: -1 | 1) => SubtitleCue | undefined;
}

/**
 * 生成批量修正建议。分四个阶段在工作副本上推进，每个建议都基于
 * 前序修正后的相邻关系校验；放不下的动作保留为问题并给出原因。
 */
export function planBatchFixes(
  cuesInput: SubtitleCue[],
  issuesInput: SubtitleIssue[],
): BatchFixPlan {
  let ordered = [...cuesInput].sort((a, b) => a.startMs - b.startMs);
  const proposals: ProposedFix[] = [];
  let seq = 0;

  const planner: Planner = {
    get ordered() {
      return ordered;
    },
    proposals,
    get seq() {
      return seq;
    },
    cue: (id) => ordered.find((item) => item.id === id),
    neighbor: (id, offset) => {
      const pos = ordered.findIndex((item) => item.id === id);
      return pos >= 0 ? ordered[pos + offset] : undefined;
    },
  };

  const originalMap = new Map(cuesInput.map((cue) => [cue.id, cue]));
  const unsupported: UnsupportedIssue[] = [];
  for (const issue of issuesInput) {
    if (issue.type === "empty" || issue.type === "too-long") {
      const cue = originalMap.get(issue.cueId);
      unsupported.push({
        issueId: issue.id,
        cueId: issue.cueId,
        index: cue?.index ?? 0,
        kind: issue.type,
        message: issue.message,
        reason: UNSUPPORTED_REASONS[issue.type],
      });
    }
  }

  /** 尝试在当前工作副本上落一条建议；落得下就推进工作副本 */
  const propose = (spec: {
    kind: FixKind;
    cueId: string;
    issueIds: string[];
    title: string;
    detailPrefix: string;
    actions: FixAction[] | null;
    blockedReason: string | null;
  }) => {
    const base = ordered;
    const updated = spec.actions ? replayActions(base, spec.actions) : null;
    const viable = spec.actions !== null && updated !== null;
    const changes = updated ? changesBetween(base, updated) : [];
    proposals.push({
      id: `fix-${++seq}-${spec.cueId}`,
      kind: spec.kind,
      cueId: spec.cueId,
      issueIds: spec.issueIds,
      title: spec.title,
      detail:
        spec.detailPrefix + (viable ? `：${describeChanges(changes)}` : ""),
      changes,
      actions: viable ? spec.actions : null,
      blockedReason: viable
        ? null
        : (spec.blockedReason ?? "相邻条目已无调整空间"),
    });
    if (viable) ordered = updated!.sort((a, b) => a.startMs - b.startMs);
  };

  /** 每个阶段基于当前工作副本重新检测，确保照顾前一步造成的相邻关系变化 */
  const runPhase = (
    type: SubtitleIssue["type"],
    handle: (issue: SubtitleIssue, fresh: SubtitleIssue[]) => void,
  ) => {
    const fresh = detectLite(ordered);
    fresh
      .filter((issue) => issue.type === type)
      .forEach((issue) => handle(issue, fresh));
  };

  runPhase("invalid-time", (issue) => {
    const cue = planner.cue(issue.cueId)!;
    const next = planner.neighbor(cue.id, 1);
    const targetEnd = cue.startMs + RULES.minDurationMs;
    const actions: FixAction[] = [];
    if (next && next.startMs < targetEnd + RULES.minGapMs)
      actions.push({
        type: "ripple",
        fromId: next.id,
        deltaMs: targetEnd + RULES.minGapMs - next.startMs,
      });
    actions.push({
      type: "set",
      cueId: cue.id,
      startMs: Math.max(0, cue.startMs),
      endMs: targetEnd,
    });
    propose({
      kind: "invalid-time",
      cueId: cue.id,
      issueIds: [issue.id],
      title: `修复第 ${cue.index} 条无效时间`,
      detailPrefix: "结束时间早于开始时间，补足为 0.8 秒",
      actions,
      blockedReason: "开始时间为负或相邻条目无法避让，需人工确认时间码",
    });
  });

  runPhase("overlap", (issue) => {
    const nxt = planner.cue(issue.cueId)!;
    const prev = planner.neighbor(nxt.id, -1)!;
    const trimEnd = nxt.startMs - RULES.minGapMs;
    // 优先缩短前一条结束端；保不住 0.8s 下限就整体后移后缀链
    if (trimEnd - prev.startMs >= RULES.minDurationMs)
      propose({
        kind: "overlap",
        cueId: prev.id,
        issueIds: [issue.id],
        title: `消除第 ${prev.index}、${nxt.index} 条重叠`,
        detailPrefix: `提前第 ${prev.index} 条结束时间，留出 0.12 秒间隔`,
        actions: [{ type: "set", cueId: prev.id, endMs: trimEnd }],
        blockedReason: null,
      });
    else {
      const delta = prev.endMs + RULES.minGapMs - nxt.startMs;
      propose({
        kind: "overlap",
        cueId: nxt.id,
        issueIds: [issue.id],
        title: `消除第 ${prev.index}、${nxt.index} 条重叠`,
        detailPrefix: `前一条已不足 0.8 秒，将第 ${nxt.index} 条及其后整体后移`,
        actions: [{ type: "ripple", fromId: nxt.id, deltaMs: delta }],
        blockedReason: "后移会越过时间轴起点，需人工调整",
      });
    }
  });

  runPhase("gap-narrow", (issue) => {
    const nxt = planner.cue(issue.cueId)!;
    const prev = planner.neighbor(nxt.id, -1)!;
    const trimEnd = nxt.startMs - RULES.minGapMs;
    if (trimEnd - prev.startMs >= RULES.minDurationMs)
      propose({
        kind: "gap-narrow",
        cueId: prev.id,
        issueIds: [issue.id],
        title: `拉开第 ${prev.index}、${nxt.index} 条间隔`,
        detailPrefix: `提前第 ${prev.index} 条结束时间至 0.12 秒间隔`,
        actions: [{ type: "set", cueId: prev.id, endMs: trimEnd }],
        blockedReason: null,
      });
    // 两侧都在下限，任何挪动都会破坏 0.8s 停留：保留问题，不整体推移
    else
      propose({
        kind: "gap-narrow",
        cueId: nxt.id,
        issueIds: [issue.id],
        title: `第 ${prev.index}、${nxt.index} 条间隔不足`,
        detailPrefix: "无法自动拉开",
        actions: null,
        blockedReason:
          "两条均已达到 0.8 秒最短停留，压缩任一条都会造成新问题，需人工重排时间",
      });
  });

  const extendFor = (issue: SubtitleIssue, fresh: SubtitleIssue[]) => {
    if (issue.type !== "too-short" && issue.type !== "too-fast") return;
    const cue = planner.cue(issue.cueId)!;
    // 同一轮里已被前面的延长建议覆盖的问题不再重复生成
    if (proposals.some((fix) => fix.issueIds.includes(issue.id))) return;
    const chars = countChars(cue.text);
    const required =
      issue.type === "too-short"
        ? RULES.minDurationMs
        : // +1ms 余量，避免毫秒取整后 CPS 仍恰好压线
          Math.floor((chars * 1000) / RULES.maxCps) + 1;
    const targetEnd = cue.startMs + Math.max(required, RULES.minDurationMs);
    const nxt = planner.neighbor(cue.id, 1);
    const room = nxt
      ? nxt.startMs - RULES.minGapMs - cue.endMs
      : Number.POSITIVE_INFINITY;
    const title =
      issue.type === "too-short"
        ? `延长第 ${cue.index} 条停留`
        : `放慢第 ${cue.index} 条阅读节奏`;
    const prefix =
      issue.type === "too-short"
        ? "结束时间延后到 0.8 秒"
        : `结束时间延后到 ${fmt(targetEnd)}（${RULES.maxCps} 字/秒以内）`;
    const companion =
      issue.type === "too-fast"
        ? fresh.find(
            (item) => item.cueId === cue.id && item.type === "too-short",
          )
        : undefined;

    if (targetEnd <= cue.endMs + Math.max(0, room)) {
      propose({
        kind: "extend",
        cueId: cue.id,
        issueIds: companion ? [issue.id, companion.id] : [issue.id],
        title,
        detailPrefix: prefix,
        actions: [{ type: "set", cueId: cue.id, endMs: targetEnd }],
        blockedReason: null,
      });
      return;
    }
    propose({
      kind: "extend",
      cueId: cue.id,
      issueIds: companion ? [issue.id, companion.id] : [issue.id],
      title,
      detailPrefix: "无法自动延长",
      actions: null,
      blockedReason: nxt
        ? `需要到 ${fmt(targetEnd)}，但下一条开始前最多到 ${fmt(
            nxt.startMs - RULES.minGapMs,
          )}（仅 ${Math.max(0, Math.round(room))}ms 空间）；后移后续字幕会改动整条时间轴，需人工确认`
        : `需要到 ${fmt(targetEnd)}，当前结束已更晚，请人工核对`,
    });
  };
  runPhase("too-short", extendFor);
  runPhase("too-fast", extendFor);

  return { fixes: proposals, unsupported };
}

/** 与 issueDetector 同规则的轻量检测，返回稳定 id（修正阶段只需 id 与类型） */
function detectLite(cues: SubtitleCue[]): SubtitleIssue[] {
  const issues: SubtitleIssue[] = [];
  const add = (
    cue: SubtitleCue,
    type: SubtitleIssue["type"],
    severity: SubtitleIssue["severity"],
  ) =>
    issues.push({
      id: `${cue.id}:${type}`,
      cueId: cue.id,
      type,
      severity,
      message: "",
    });
  const ordered = [...cues].sort((a, b) => a.startMs - b.startMs);
  ordered.forEach((cue, i) => {
    const duration = cue.endMs - cue.startMs,
      chars = countChars(cue.text);
    if (!cue.text.trim()) add(cue, "empty", "error");
    if (duration <= 0) add(cue, "invalid-time", "error");
    else {
      if (duration < RULES.minDurationMs) add(cue, "too-short", "warning");
      if (chars / (duration / 1000) > RULES.maxCps)
        add(cue, "too-fast", "warning");
    }
    if (chars > RULES.maxChars || cue.text.split("\n").length > RULES.maxLines)
      add(cue, "too-long", "warning");
    const next = ordered[i + 1];
    if (next && next.startMs < cue.endMs) add(next, "overlap", "error");
    else if (next && next.startMs - cue.endMs < RULES.minGapMs)
      add(next, "gap-narrow", "info");
  });
  return issues;
}
