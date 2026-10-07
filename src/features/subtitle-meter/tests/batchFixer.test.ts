import { describe, expect, it } from "vitest";
import { detectIssues, RULES } from "../analyzers/issueDetector";
import {
  changesBetween,
  planBatchFixes,
  replayActions,
} from "../analyzers/batchFixer";
import type { SubtitleCue } from "../models";

const cue = (
  id: number | string,
  startMs: number,
  endMs: number,
  text = "短字幕",
): SubtitleCue => ({
  id: `cue-${id}`,
  index: Number(id),
  startMs,
  endMs,
  text,
});

const planFor = (cues: SubtitleCue[]) =>
  planBatchFixes(cues, detectIssues(cues));
const viable = (plan: ReturnType<typeof planFor>) =>
  plan.fixes.filter((fix) => fix.actions);
const blocked = (plan: ReturnType<typeof planFor>) =>
  plan.fixes.filter((fix) => !fix.actions);

describe("batch fix planning", () => {
  it("extends a too-short cue only into available room without touching next", () => {
    const cues = [cue(1, 0, 500), cue(2, 2000, 3000)];
    const plan = planFor(cues);
    const fix = viable(plan).find((f) => f.kind === "extend")!;
    expect(fix).toBeTruthy();
    const updated = replayActions(cues, fix.actions!)!;
    expect(updated[0].endMs).toBe(RULES.minDurationMs);
    expect(updated[1]).toEqual(cues[1]);
    expect(detectIssues(updated).some((i) => i.type === "too-short")).toBe(
      false,
    );
  });

  it("keeps the next cue intact when extending: no new overlap or narrow gap", () => {
    // 第一条 300ms，下一条 1000ms 开始：延长到 800 后间隔为 200ms，安全
    const cues = [cue(1, 0, 300), cue(2, 1000, 2000)];
    const fix = viable(planFor(cues)).find((f) => f.cueId === "cue-1")!;
    const updated = replayActions(cues, fix.actions!)!;
    expect(updated[0].endMs).toBe(800);
    expect(updated[1].startMs).toBe(1000);
    const issues = detectIssues(updated).map((i) => i.type);
    expect(issues).not.toContain("overlap");
    expect(issues).not.toContain("gap-narrow");
  });

  it("blocks extension when there is not enough room before the next cue", () => {
    // 第一条 300ms，下一条 900ms 开始：保留 120ms 间隔后最多延到 780，放不下 800
    const cues = [cue(1, 0, 300), cue(2, 900, 2000)];
    const plan = planFor(cues);
    const extend = plan.fixes.find((f) => f.kind === "extend")!;
    expect(extend.actions).toBeNull();
    expect(extend.blockedReason).toContain("需人工确认");
    expect(blocked(plan)).toHaveLength(1);
  });

  it("resolves overlap by trimming the previous cue end above the duration floor", () => {
    const cues = [cue(1, 0, 2000), cue(2, 1500, 3000)];
    const fix = viable(planFor(cues)).find((f) => f.kind === "overlap")!;
    const updated = replayActions(cues, fix.actions!)!;
    expect(updated[0].endMs).toBe(1500 - RULES.minGapMs);
    expect(updated[0].endMs - updated[0].startMs).toBeGreaterThanOrEqual(
      RULES.minDurationMs,
    );
    expect(detectIssues(updated).some((i) => i.type === "overlap")).toBe(false);
  });

  it("ripples the suffix later when trimming would break the duration floor", () => {
    // 前一条 900ms（不能再短于 800），与后一条重叠 300ms
    const cues = [cue(1, 0, 900), cue(2, 600, 1600), cue(3, 2000, 3000)];
    const fix = viable(planFor(cues)).find((f) => f.kind === "overlap")!;
    expect(fix.actions?.[0].type).toBe("ripple");
    const updated = replayActions(cues, fix.actions!)!;
    // 后缀链间隔不变，链首被推到前一条结束 + 120
    expect(updated[1].startMs).toBe(1020);
    expect(updated[1].endMs).toBe(2020);
    expect(updated[2].startMs - updated[1].endMs).toBe(
      cues[2].startMs - cues[1].endMs,
    );
    expect(detectIssues(updated)).toHaveLength(0);
  });

  it("widens a narrow gap by trimming the previous cue when possible", () => {
    // 间隔只有 50ms，前一条有足够缩短空间
    const cues = [cue(1, 0, 1950), cue(2, 2000, 3000)];
    const fix = viable(planFor(cues)).find((f) => f.kind === "gap-narrow");
    expect(fix).toBeTruthy();
    const updated = replayActions(cues, fix!.actions!)!;
    expect(updated[0].endMs).toBe(2000 - RULES.minGapMs);
    expect(detectIssues(updated).some((i) => i.type === "gap-narrow")).toBe(
      false,
    );
  });

  it("keeps a narrow-gap issue when both cues are already at the floor", () => {
    // 两条都恰好 800ms、间隔 50ms：压缩任一条都会造成 too-short
    const cues = [cue(1, 0, 800), cue(2, 850, 1650)];
    const plan = planFor(cues);
    const fix = plan.fixes.find((f) => f.kind === "gap-narrow")!;
    expect(fix.actions).toBeNull();
    expect(fix.blockedReason).toContain("最短停留");
  });

  it("lists empty and too-long issues as unsupported with explicit reasons", () => {
    const longText = "这是一个用于检查速度的非常长的字幕内容".repeat(3);
    const cues = [cue(1, 0, 3000, ""), cue(2, 4000, 8000, longText)];
    const { unsupported } = planFor(cues);
    expect(unsupported.map((u) => u.kind).sort()).toEqual([
      "empty",
      "too-long",
    ]);
    expect(unsupported.every((u) => u.reason.length > 0)).toBe(true);
  });

  it("fixes invalid time with a suffix ripple when a later cue blocks it", () => {
    const cues = [cue(1, 2000, 1000), cue(2, 2200, 3000)];
    const fix = viable(planFor(cues)).find((f) => f.kind === "invalid-time")!;
    const updated = replayActions(cues, fix.actions!)!;
    expect(updated[0].endMs - updated[0].startMs).toBe(RULES.minDurationMs);
    expect(updated[1].startMs - updated[0].endMs).toBeGreaterThanOrEqual(
      RULES.minGapMs,
    );
    expect(detectIssues(updated).some((i) => i.type === "invalid-time")).toBe(
      false,
    );
  });

  it("executing the whole plan resolves every fixable issue in sequence", () => {
    const cues = [
      cue(1, 0, 2000),
      cue(2, 1500, 1900), // overlap + invalid，ripple 修复
      cue(3, 2600, 3000), // 修复后间隔 480ms，正常；但本条仅 400ms
      cue(4, 5000, 5600),
    ];
    const plan = planFor(cues);
    let working = cues;
    for (const fix of plan.fixes) {
      if (fix.actions) {
        const updated = replayActions(working, fix.actions);
        expect(updated, fix.title).not.toBeNull();
        working = updated!;
      }
    }
    // cue-3 的 400ms 在下一条 5000 前有充足空间延长
    const remaining = detectIssues(working)
      .map((i) => i.type)
      .filter((type) => type !== "empty" && type !== "too-long");
    expect(remaining).toEqual([]);
  });

  it("keeps an issue in the plan when later phases leave no room to fix it", () => {
    // 无效时间修复后 cue-2 仅剩 400ms，而 cue-3 紧接着只留 50ms 间隔：
    // 延长会顶到下一条，问题必须保留并给出原因
    const cues = [cue(1, 0, 2000), cue(2, 1500, 1900), cue(3, 2300, 3300)];
    const plan = planFor(cues);
    let working = cues;
    for (const fix of plan.fixes)
      if (fix.actions) working = replayActions(working, fix.actions)!;
    const extend = plan.fixes.filter((f) => f.kind === "extend");
    expect(extend.some((f) => f.actions === null)).toBe(true);
    const remaining = detectIssues(working).map((i) => i.type);
    expect(remaining).toContain("too-short");
  });

  it("reports every affected cue before/after range for preview", () => {
    const cues = [cue(1, 0, 900), cue(2, 600, 1600), cue(3, 2000, 3000)];
    const fix = viable(planFor(cues)).find((f) => f.kind === "overlap")!;
    expect(fix.changes.map((c) => c.cueId)).toEqual(["cue-2", "cue-3"]);
    expect(fix.detail).toContain("#2");
    expect(fix.detail).toContain("#3");
    // changesBetween 对比的是执行前后的完整快照
    expect(
      changesBetween(cues, replayActions(cues, fix.actions!)!),
    ).toHaveLength(2);
  });

  it("combines too-short and too-fast into one extension sized by CPS", () => {
    const text = "这是二十个字符长度的字幕内容需要放慢节奏";
    expect([...text.replace(/\s/g, "")].length).toBe(20);
    const cues = [cue(1, 0, 300, text)];
    const plan = planFor(cues);
    const extendsFix = viable(plan).filter((f) => f.kind === "extend");
    // too-short 先延到 0.8s；too-fast 阶段再基于新状态追加到 CPS 达标
    expect(extendsFix.length).toBeGreaterThanOrEqual(1);
    const finalFix = extendsFix.at(-1)!;
    let working = cues;
    for (const fix of extendsFix)
      working = replayActions(working, fix.actions!)!;
    expect(finalFix.issueIds).toContain("cue-1:too-fast");
    const updated = working;
    const cps =
      [...cues[0].text.replace(/\s/g, "")].length /
      ((updated[0].endMs - updated[0].startMs) / 1000);
    expect(cps).toBeLessThanOrEqual(RULES.maxCps);
    expect(updated[0].endMs - updated[0].startMs).toBeGreaterThanOrEqual(
      RULES.minDurationMs,
    );
  });
});
