import { describe, expect, it } from "vitest";
import { buildBatchFixPlan } from "../analyzers/batchFixer";
import { detectIssues } from "../analyzers/issueDetector";
import type { SubtitleCue } from "../models";

const cue = (
  id: string,
  startMs: number,
  endMs: number,
  text = "普通长度的字幕文本内容",
): SubtitleCue => ({ id, index: Number(id), startMs, endMs, text });

describe("batch fix planner", () => {
  it("resolves an overlap by trimming the earlier cue with a safety gap", () => {
    const cues = [cue("1", 0, 1500), cue("2", 1000, 3000)];
    const plan = buildBatchFixPlan(cues, detectIssues(cues));
    expect(plan.proposals).toHaveLength(1);
    const p = plan.proposals[0];
    expect(p.cueId).toBe("1");
    expect(p.after.endMs).toBe(880);
    expect(plan.cues[1]).toMatchObject({ startMs: 1000, endMs: 3000 });
    expect(plan.unresolved.map((u) => u.type)).not.toContain("overlap");
    // 落地后全量复检无重叠、无新增间隔问题
    expect(
      detectIssues(plan.cues).some((i) =>
        ["overlap", "gap-too-narrow"].includes(i.type),
      ),
    ).toBe(false);
  });

  it("fixes a too-narrow gap by shortening the previous cue", () => {
    const cues = [cue("1", 0, 2000), cue("2", 2050, 4000)];
    const plan = buildBatchFixPlan(cues, detectIssues(cues));
    const p = plan.proposals.find((x) => x.cueId === "1");
    expect(p).toBeDefined();
    expect(plan.cues[1].startMs - plan.cues[0].endMs).toBe(120);
  });

  it("delays the later cue when the previous one cannot be shortened", () => {
    // 上一条本身已短于 800ms，再压缩会更短，只能整体延后下一条
    const cues = [
      cue("1", 0, 700, "短"),
      cue("2", 750, 3000, "第二条普通长度的字幕文本内容"),
    ];
    const plan = buildBatchFixPlan(cues, detectIssues(cues));
    const first = plan.cues[0];
    expect(first.endMs).toBe(700);
    expect(plan.cues[1].startMs).toBe(first.endMs + 120);
  });

  it("extends a too-short cue into the available room on both sides", () => {
    const cues = [
      cue("1", 0, 3000),
      cue("2", 3500, 3900, "短"),
      cue("3", 4400, 7000),
    ];
    const plan = buildBatchFixPlan(cues, detectIssues(cues));
    const p = plan.proposals.find((x) => x.cueId === "2");
    expect(p).toBeDefined();
    const mid = plan.cues[1];
    expect(mid.endMs - mid.startMs).toBeGreaterThanOrEqual(800);
    expect(mid.startMs - plan.cues[0].endMs).toBeGreaterThanOrEqual(120);
    expect(plan.cues[2].startMs - mid.endMs).toBeGreaterThanOrEqual(120);
  });

  it("extends duration only enough to bring CPS under the limit", () => {
    const longText =
      "这是一段比较长一些的字幕内容需要更久的停留时间才能被从容读完";
    const cues = [cue("1", 0, 1500, longText), cue("2", 6000, 8000)];
    const plan = buildBatchFixPlan(cues, detectIssues(cues));
    const p = plan.proposals.find((x) => x.cueId === "1");
    expect(p).toBeDefined();
    const chars = [...longText.replace(/\s/g, "")].length;
    const dur = plan.cues[0].endMs - plan.cues[0].startMs;
    expect(dur).toBeGreaterThanOrEqual(chars * (1000 / 18) - 1);
  });

  it("keeps issues unresolved when no room exists and explains why", () => {
    const cues = [
      cue("1", 0, 1000),
      cue("2", 1120, 1500),
      cue("3", 1620, 3000),
    ];
    const plan = buildBatchFixPlan(cues, detectIssues(cues));
    const types = plan.unresolved.map((u) => u.type);
    expect(types).toContain("too-short");
    for (const u of plan.unresolved) expect(u.reason.length).toBeGreaterThan(0);
  });

  it("never lists manual issue types as proposals and always gives reasons", () => {
    const longText = "超长字幕".repeat(28); // 112 字
    const cues = [cue("1", 0, 1000, ""), cue("2", 2000, 3000, longText)];
    const before = detectIssues(cues);
    // 112 字需 6.2 秒，扩到 6 秒上限也无法降到 18 字/秒
    expect([...longText.replace(/\s/g, "")].length).toBe(112);
    const plan = buildBatchFixPlan(cues, before);
    const proposedTypes = plan.proposals.flatMap((p) =>
      p.issueIds.map((id) => before.find((i) => i.id === id)?.type),
    );
    expect(proposedTypes).not.toContain("empty");
    expect(proposedTypes).not.toContain("too-long");
    expect(proposedTypes).not.toContain("too-fast");
    const unresolvedTypes = plan.unresolved.map((u) => u.type);
    expect(unresolvedTypes).toContain("empty");
    expect(unresolvedTypes).toContain("too-long");
    expect(unresolvedTypes).toContain("too-fast");
  });

  it("leaves an invalid-time cue untouched on every pass", () => {
    const cues = [
      cue("1", 2000, 1000, "时间反了"),
      cue("2", 1500, 3000, "相邻的一条普通长度的字幕内容"),
    ];
    const plan = buildBatchFixPlan(cues, detectIssues(cues));
    expect(plan.cues.find((c) => c.id === "1")).toMatchObject({
      startMs: 2000,
      endMs: 1000,
    });
    expect(plan.unresolved.map((u) => u.type)).toContain("invalid-time");
  });

  it("does not extend a cue into an invalid-time neighbour", () => {
    // 按开始时间排序：有效短条 [0,300] 在前，无效条 [100,50] 在后
    const cues = [cue("1", 0, 300, "短"), cue("2", 100, 50, "时间反了")];
    const plan = buildBatchFixPlan(cues, detectIssues(cues));
    const shortCue = plan.cues.find((c) => c.id === "1")!;
    // 不能向右越过无效条的起点 100ms
    expect(shortCue.endMs).toBeLessThanOrEqual(300);
    // 短条问题保留并给出原因，而不是制造一条与无效条的新重叠
    expect(plan.unresolved.map((u) => u.type)).toContain("too-short");
  });

  it("never introduces a problem that was not present before the plan", () => {
    // 覆盖多种病态相邻关系的随机化不变量：方案后问题签名 ⊆ 方案前问题签名
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(rand() * 6);
      const times = Array.from({ length: n }, () => {
        const s = Math.floor(rand() * 4000);
        const len = Math.floor(rand() * 2200) - 200; // 允许无效时间
        return { s, e: s + len };
      });
      const texts = ["短", "", "普通长度的字幕文本", "超长字幕".repeat(12)];
      const cues: SubtitleCue[] = times.map((t, i) =>
        cue(
          String(i + 1),
          Math.max(0, t.s),
          Math.max(0, t.e),
          texts[Math.floor(rand() * texts.length)],
        ),
      );
      const before = new Set(
        detectIssues(cues).map((i) => `${i.cueId}|${i.type}`),
      );
      const plan = buildBatchFixPlan(cues, detectIssues(cues));
      for (const after of detectIssues(plan.cues))
        expect(before.has(`${after.cueId}|${after.type}`)).toBe(true);
    }
  });

  it("removes every claimed issue and never introduces new ones", () => {
    const cues = [
      cue("1", 0, 2000),
      cue("2", 2050, 3000, "短"),
      cue("3", 3050, 6000),
    ];
    const before = detectIssues(cues);
    const plan = buildBatchFixPlan(cues, before);
    const fixedSigs = new Set(
      plan.proposals.flatMap((p) =>
        p.issueIds.map((id) => {
          const issue = before.find((i) => i.id === id)!;
          return `${issue.cueId}|${issue.type}`;
        }),
      ),
    );
    const afterSigs = new Set(
      detectIssues(plan.cues).map((i) => `${i.cueId}|${i.type}`),
    );
    for (const sig of fixedSigs) expect(afterSigs.has(sig)).toBe(false);
    for (const sig of afterSigs)
      expect(plan.unresolved.some((u) => `${u.cueId}|${u.type}` === sig)).toBe(
        true,
      );
  });
});
