import type { SubtitleCue, SubtitleIssue } from "../models";

/** 检查规则：批量修正必须与这些阈值保持一致 */
export const RULES = {
  minDurationMs: 800,
  minGapMs: 120,
  maxCps: 18,
  maxChars: 42,
  maxLines: 2,
};

export function countChars(text: string): number {
  return [...text.replace(/\s/g, "")].length;
}

export function detectIssues(cues: SubtitleCue[]): SubtitleIssue[] {
  const issues: SubtitleIssue[] = [];
  const add = (
    cue: SubtitleCue,
    type: SubtitleIssue["type"],
    severity: SubtitleIssue["severity"],
    message: string,
  ) =>
    issues.push({
      // 稳定 id：不随问题数量变化，重新检测 / 快照回退后保持一致
      id: `${cue.id}:${type}`,
      cueId: cue.id,
      type,
      severity,
      message,
    });
  const ordered = [...cues].sort((a, b) => a.startMs - b.startMs);
  ordered.forEach((cue, i) => {
    const duration = cue.endMs - cue.startMs,
      chars = countChars(cue.text);
    if (!cue.text.trim()) add(cue, "empty", "error", "字幕文本为空");
    if (duration <= 0)
      add(cue, "invalid-time", "error", "结束时间必须晚于开始时间");
    else {
      if (duration < RULES.minDurationMs)
        add(
          cue,
          "too-short",
          "warning",
          `显示仅 ${(duration / 1000).toFixed(1)} 秒`,
        );
      const cps = chars / (duration / 1000);
      if (cps > RULES.maxCps)
        add(cue, "too-fast", "warning", `阅读速度 ${cps.toFixed(1)} 字/秒`);
    }
    if (chars > RULES.maxChars || cue.text.split("\n").length > RULES.maxLines)
      add(
        cue,
        "too-long",
        "warning",
        chars > RULES.maxChars
          ? `${chars} 字，建议精简`
          : "超过两行，画面占用较高",
      );
    const next = ordered[i + 1];
    if (next && next.startMs < cue.endMs)
      add(
        next,
        "overlap",
        "error",
        `与第 ${cue.index} 条字幕重叠 ${((cue.endMs - next.startMs) / 1000).toFixed(1)} 秒`,
      );
    else if (next && next.startMs - cue.endMs < RULES.minGapMs)
      add(next, "gap-narrow", "info", "与上一条间隔不足 0.12 秒");
  });
  return issues;
}
