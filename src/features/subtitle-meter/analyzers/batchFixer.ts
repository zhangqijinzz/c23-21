import { detectIssues } from "./issueDetector";
import type { IssueType, SubtitleCue, SubtitleIssue } from "../models";

export const MIN_GAP_MS = 120;
export const MIN_DURATION_MS = 800;
export const MAX_CPS = 18;
export const MAX_DURATION_MS = 6000;

export interface TimeRange {
  startMs: number;
  endMs: number;
}
export interface FixProposal {
  id: string;
  cueId: string;
  cueIndex: number;
  before: TimeRange;
  after: TimeRange;
  change: string;
  issueIds: string[];
  issueLabels: string[];
}
export interface UnresolvedFix {
  issueId: string;
  cueId: string;
  cueIndex: number;
  type: IssueType;
  severity: SubtitleIssue["severity"];
  message: string;
  reason: string;
}
export interface BatchFixPlan {
  cues: SubtitleCue[];
  proposals: FixProposal[];
  unresolved: UnresolvedFix[];
}
export interface AppliedFix extends FixProposal {
  appliedAt: number;
}

export const ISSUE_LABELS: Record<IssueType, string> = {
  overlap: "时间重叠",
  "gap-too-narrow": "间隔不足",
  "too-short": "停留过短",
  "too-fast": "阅读过快",
  "too-long": "文本超长",
  empty: "文本为空",
  "invalid-time": "时间码无效",
};

export const MANUAL_ISSUE_TYPES: Array<{
  type: IssueType;
  label: string;
  hint: string;
}> = [
  {
    type: "empty",
    label: "空文本",
    hint: "需要补充或确认文案，工具不会自动生成字幕内容",
  },
  {
    type: "too-long",
    label: "文本超长 / 超过两行",
    hint: "需要精简文案或重新断行，属于内容修改，不自动处理",
  },
  {
    type: "invalid-time",
    label: "时间码无效",
    hint: "结束时间不晚于开始时间，需人工核对原始文件的时间码",
  },
];

const MANUAL_REASONS: Partial<Record<IssueType, string>> = {
  empty: "需要补充或确认字幕文案，无法自动生成内容",
  "too-long": "需要精简文案或重新断行，属于内容修改，不自动处理",
  "invalid-time": "时间码本身无效，请人工核对原始文件中的时间码",
};

export const countChars = (text: string) => [...text.replace(/\s/g, "")].length;

const signed = (ms: number) =>
  `${ms < 0 ? "−" : "+"}${(Math.abs(ms) / 1000).toFixed(2)}s`;

export function describeChange(before: TimeRange, after: TimeRange): string {
  const parts: string[] = [];
  if (after.startMs !== before.startMs)
    parts.push(`开始 ${signed(after.startMs - before.startMs)}`);
  if (after.endMs !== before.endMs)
    parts.push(`结束 ${signed(after.endMs - before.endMs)}`);
  return parts.length ? parts.join("，") : "保持不变";
}

export function formatMs(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(2)}s`;
}

/**
 * 基于当前 cues 与检查结果生成批量修正方案。
 * 三趟顺序处理（重叠 → 间隔 → 停留时长），每一趟只在相邻条目
 * 留出的边界内修改，保证不会顶掉下一条或制造新的重叠；放不下
 * 的问题保留在 unresolved 中并给出原因。
 */
export function buildBatchFixPlan(
  cuesInput: SubtitleCue[],
  issues: SubtitleIssue[],
): BatchFixPlan {
  const ordered = [...cuesInput].sort((a, b) => a.startMs - b.startMs);
  const work = new Map(ordered.map((c) => [c.id, { ...c }]));
  const originals = new Map(
    ordered.map((c) => [c.id, { startMs: c.startMs, endMs: c.endMs }]),
  );
  const ids = ordered.map((c) => c.id);
  const cue = (id: string) => work.get(id)!;
  const issueById = new Map(issues.map((i) => [i.id, i]));
  const proposals = new Map<string, FixProposal>();
  const reasons = new Map<string, string>();
  const valid = (c: SubtitleCue) => c.endMs - c.startMs > 0;

  const touch = (cueId: string): FixProposal => {
    let p = proposals.get(cueId);
    if (!p) {
      const c = cue(cueId),
        o = originals.get(cueId)!;
      p = {
        id: `fix-${cueId}`,
        cueId,
        cueIndex: c.index,
        before: { ...o },
        after: { ...o },
        change: "",
        issueIds: [],
        issueLabels: [],
      };
      proposals.set(cueId, p);
    }
    return p;
  };
  const link = (cueId: string, issueId: string | undefined) => {
    if (!issueId) return;
    const issue = issueById.get(issueId);
    if (!issue) return;
    const p = touch(cueId);
    if (!p.issueIds.includes(issueId)) {
      p.issueIds.push(issueId);
      p.issueLabels.push(ISSUE_LABELS[issue.type]);
    }
  };
  const findIssue = (cueId: string, ...types: IssueType[]) =>
    issues.find((i) => i.cueId === cueId && types.includes(i.type))?.id;
  // 条目不产生“停留过短 / 阅读过快”所需的最小时长
  const requiredMs = (c: SubtitleCue) =>
    Math.max(MIN_DURATION_MS, Math.ceil((countChars(c.text) * 1000) / MAX_CPS));
  // 收缩某条结束时间时的最早允许值：既要保住自身时长/速度，也不能压窄与上一条的间隔
  const earliestEndAfterShrink = (indexInOrder: number, c: SubtitleCue) => {
    const p = indexInOrder > 0 ? cue(ids[indexInOrder - 1]) : null;
    const predFloor = p && valid(p) ? p.endMs + MIN_GAP_MS : -Infinity;
    return Math.max(c.startMs + requiredMs(c), predFloor);
  };

  // 第一趟：消除重叠。优先提前上一条的结束时间（不整体后移，避免连锁顶掉后续条目）。
  for (let i = 0; i + 1 < ids.length; i++) {
    const a = cue(ids[i]),
      b = cue(ids[i + 1]);
    if (!valid(a)) continue;
    const overlapId = findIssue(b.id, "overlap");
    if (overlapId && b.startMs < a.endMs) {
      const newEnd = b.startMs - MIN_GAP_MS;
      // 提前结束不能压坏自身时长/速度、不能顶窄与上一条的间隔；下一条无效时不动
      if (valid(b) && newEnd >= earliestEndAfterShrink(i, a)) {
        a.endMs = newEnd;
        link(a.id, overlapId);
      } else {
        reasons.set(
          overlapId,
          `第 ${a.index} 条提前结束仍无法与第 ${b.index} 条分开（会压窄与上一条间隔、破坏停留时长，或对方时间码无效），请人工移动整条时间块`,
        );
      }
    }
  }

  // 第二趟：补足相邻间隔。先压缩上一条停留；压不动则把下一条整体延后。
  for (let i = 0; i + 1 < ids.length; i++) {
    const a = cue(ids[i]),
      b = cue(ids[i + 1]);
    if (!valid(a) || !valid(b)) continue;
    const gap = b.startMs - a.endMs;
    if (gap >= 0 && gap < MIN_GAP_MS) {
      const gapId = findIssue(b.id, "gap-too-narrow");
      const newEndAfterCompress = a.endMs - (MIN_GAP_MS - gap);
      if (newEndAfterCompress >= earliestEndAfterShrink(i, a)) {
        a.endMs = newEndAfterCompress;
        link(a.id, gapId);
      } else {
        const c = i + 2 < ids.length ? cue(ids[i + 2]) : null;
        const newStart = a.endMs + MIN_GAP_MS;
        // 延后 b 起点必须同时满足：① b 自身停留/阅读速度不被压坏；
        // ② 不能越过或贴到再下一条 c（否则会制造新的窄间隔/重叠并打乱顺序）。
        // 无 c 时可自由延后；c 时间码无效时保守不延后。
        const selfOk =
          newStart < b.endMs && b.endMs - newStart >= requiredMs(b);
        const nextGapOk =
          c === null
            ? true
            : valid(c)
              ? c.startMs - newStart >= MIN_GAP_MS
              : false;
        if (selfOk && nextGapOk) {
          b.startMs = newStart;
          link(b.id, gapId);
        } else if (gapId) {
          reasons.set(
            gapId,
            `第 ${a.index}、${b.index} 条之间任一侧压缩后都会短于最短停留、压窄与相邻条目的间隔或让阅读速度超标，需要人工重排时间`,
          );
        }
      }
    }
  }

  // 第三趟：延长停留过短 / 阅读过快的条目。先向右借空间，不够再向左，全程不越过相邻边界。
  ids.forEach((id, i) => {
    const c = cue(id);
    if (!valid(c)) return;
    const shortId = findIssue(c.id, "too-short");
    const fastId = findIssue(c.id, "too-fast");
    if (!shortId && !fastId) return;

    const chars = countChars(c.text);
    const needDur = Math.max(
      MIN_DURATION_MS,
      Math.ceil((chars * 1000) / MAX_CPS),
    );
    const capReason = `文本 ${chars} 字，至少需要 ${(needDur / 1000).toFixed(2)} 秒才能降到 ${MAX_CPS} 字/秒，超过单条 ${MAX_DURATION_MS / 1000} 秒上限，请精简文案`;
    const fastFixable = !!fastId && needDur <= MAX_DURATION_MS;
    if (!shortId && !fastFixable) {
      if (fastId) reasons.set(fastId, capReason);
      return;
    }

    // 边界以排序上紧邻的条目为准：对方有效则在其与本条之间保留安全间隔；
    // 紧邻条目时间码无效（位置可能怪异）则该方向完全不扩展，避免产生新冲突。
    const prevNeighbor = i > 0 ? cue(ids[i - 1]) : null;
    const nextNeighbor = i + 1 < ids.length ? cue(ids[i + 1]) : null;
    let minStart = 0,
      maxEnd = Infinity;
    if (prevNeighbor) {
      if (valid(prevNeighbor)) minStart = prevNeighbor.endMs + MIN_GAP_MS;
      else minStart = c.startMs;
    }
    if (nextNeighbor) {
      if (valid(nextNeighbor)) maxEnd = nextNeighbor.startMs - MIN_GAP_MS;
      else maxEnd = c.endMs;
    }
    const curDur = c.endMs - c.startMs;
    const leftRoom = Math.max(0, c.startMs - minStart);
    const rightRoom = Math.max(0, maxEnd - c.endMs);
    const achievable = curDur + leftRoom + rightRoom;
    const targetDur = Math.min(
      MAX_DURATION_MS,
      Math.max(MIN_DURATION_MS, needDur),
    );
    const noRoomReason = `相邻条目之间最多只能扩到 ${(achievable / 1000).toFixed(2)} 秒，达不到要求，请精简文案或人工挪动相邻字幕`;

    // 只有能真正消除至少一个问题时才动时间，避免无意义改动连带影响相邻条目
    const canFixShort = !!shortId && achievable >= MIN_DURATION_MS;
    const canFixFast = fastFixable && achievable >= needDur;
    if (!canFixShort && !canFixFast) {
      if (shortId) reasons.set(shortId, noRoomReason);
      if (fastId) reasons.set(fastId, fastFixable ? noRoomReason : capReason);
      return;
    }

    const chosenDur = Math.min(targetDur, achievable);
    const add = chosenDur - curDur;
    const rightAdd = Math.min(add, rightRoom);
    c.endMs += rightAdd;
    c.startMs -= add - rightAdd;
    if (canFixShort) link(c.id, shortId);
    else if (shortId) reasons.set(shortId, noRoomReason);
    if (canFixFast) link(c.id, fastId);
    else if (fastId)
      reasons.set(fastId, fastFixable ? noRoomReason : capReason);
  });
  const finalCues = ids.map((id) => ({ ...cue(id) }));
  for (const p of proposals.values()) {
    const c = cue(p.cueId);
    p.after = { startMs: c.startMs, endMs: c.endMs };
  }

  // 兜底复检：方案落地后重新全量检查，未真正消除的问题从提案中撤回并说明。
  const remainingSig = new Set(
    detectIssues(finalCues).map((r) => `${r.cueId}|${r.type}`),
  );
  for (const p of proposals.values()) {
    const keptIds: string[] = [],
      keptLabels: string[] = [];
    p.issueIds.forEach((issueId, idx) => {
      const issue = issueById.get(issueId)!;
      if (!remainingSig.has(`${issue.cueId}|${issue.type}`)) {
        keptIds.push(issueId);
        keptLabels.push(p.issueLabels[idx]);
      } else if (!reasons.has(issueId)) {
        reasons.set(
          issueId,
          "受相邻条目限制，自动调整后该项仍未达标，请人工处理",
        );
      }
    });
    p.issueIds = keptIds;
    p.issueLabels = keptLabels;
  }

  // 没有实际解决任何问题的提案丢弃，其 cue 恢复原时间，保证“执行提案”与方案完全一致。
  const proposalList = ids
    .map((id) => proposals.get(id))
    .filter((p): p is FixProposal => !!p)
    .filter((p) => {
      if (p.issueIds.length > 0) {
        p.change = describeChange(p.before, p.after);
        return true;
      }
      const target = finalCues.find((x) => x.id === p.cueId);
      if (target) {
        target.startMs = p.before.startMs;
        target.endMs = p.before.endMs;
      }
      return false;
    });

  const linked = new Set<string>();
  proposalList.forEach((p) => p.issueIds.forEach((id) => linked.add(id)));
  const unresolved: UnresolvedFix[] = [];
  for (const issue of issues) {
    if (linked.has(issue.id)) continue;
    unresolved.push({
      issueId: issue.id,
      cueId: issue.cueId,
      cueIndex: work.get(issue.cueId)?.index ?? 0,
      type: issue.type,
      severity: issue.severity,
      message: issue.message,
      reason:
        reasons.get(issue.id) ??
        MANUAL_REASONS[issue.type] ??
        "当前无法自动处理，请人工调整",
    });
  }

  return { cues: finalCues, proposals: proposalList, unresolved };
}
