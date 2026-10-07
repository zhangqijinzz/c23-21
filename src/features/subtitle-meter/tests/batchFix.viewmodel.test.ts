import { describe, expect, it, vi } from "vitest";
import { SubtitleMeterViewModel } from "../viewmodels/subtitleMeterViewModel";
import { RULES } from "../analyzers/issueDetector";
import type { SubtitleCue } from "../models";

vi.mock("../repositories/projectRepository", () => ({
  projectRepository: {
    save: vi.fn(async () => undefined),
    load: vi.fn(async () => null),
  },
}));
vi.mock("../services/exportService", () => ({ downloadSubtitles: vi.fn() }));

const cue = (
  id: number,
  startMs: number,
  endMs: number,
  text = "短字幕",
): SubtitleCue => ({ id: `cue-${id}`, index: id, startMs, endMs, text });

async function vmWith(cues: SubtitleCue[]) {
  const vm = new SubtitleMeterViewModel();
  // 直接注入项目，绕过文件解析
  const project = {
    id: "subtitle-meter.current.v1",
    name: "clip.srt",
    format: "srt" as const,
    cues,
    updatedAt: 1,
    versions: [],
  };
  await vm["commit"](project, "ready");
  return vm;
}

describe("batch fix view model", () => {
  it("applies chosen fixes, removes the issues, and stores before/after snapshots", async () => {
    const vm = await vmWith([cue(1, 0, 300), cue(2, 2000, 3000)]);
    expect(vm.state.issues.some((i) => i.type === "too-short")).toBe(true);
    const preview = vm.previewBatchFixes()!;
    const ready = preview.fixes.filter((f) => f.actions);
    expect(ready.length).toBe(1);
    await vm.applyBatchFixes(ready);
    expect(vm.state.project!.cues[0].endMs).toBe(RULES.minDurationMs);
    expect(vm.state.issues.some((i) => i.type === "too-short")).toBe(false);
    const versions = vm.state.project!.versions;
    expect(versions.filter((v) => v.kind === "batch-before")).toHaveLength(1);
    expect(versions.filter((v) => v.kind === "batch-after")).toHaveLength(1);
    expect(versions[0].issueIds).toContain("cue-1:too-short");
    expect(vm.state.batchFix?.fixes).toHaveLength(1);
  });

  it("undoes a single fix restoring its issue without creating new ones", async () => {
    const vm = await vmWith([cue(1, 0, 300), cue(2, 2000, 3000)]);
    const [fix] = vm.previewBatchFixes()!.fixes;
    await vm.applyBatchFixes([fix]);
    expect(vm.state.issues.some((i) => i.type === "too-short")).toBe(false);
    await vm.undoFix(vm.state.batchFix!.fixes[0].id);
    expect(vm.state.project!.cues[0].endMs).toBe(300);
    expect(vm.state.issues.some((i) => i.type === "too-short")).toBe(true);
    expect(vm.state.batchFix!.fixes[0].undone).toBe(true);
  });

  it("refuses single undo after the affected cue was manually edited", async () => {
    const vm = await vmWith([cue(1, 0, 300), cue(2, 2000, 3000)]);
    const [fix] = vm.previewBatchFixes()!.fixes;
    await vm.applyBatchFixes([fix]);
    await vm.editCue("cue-1", { endMs: 850 });
    await vm.undoFix(vm.state.batchFix!.fixes[0].id);
    expect(vm.state.notice).toContain("手动改过");
    expect(vm.state.project!.cues[0].endMs).toBe(850);
  });

  it("replays selected fixes from scratch and reports dependent fixes that become unsafe", async () => {
    // #1 2000ms 与 #2(300ms) 重叠：计划是"提前 #1 到 1480"，随后延长 #2 到 800。
    // 只执行延长、不执行重叠处理时，#2 的延长会撞进 #1 -> 必须跳过并说明
    const cues = [cue(1, 0, 2000), cue(2, 1600, 1900), cue(3, 5000, 6000)];
    const vm = await vmWith(cues);
    const preview = vm.previewBatchFixes()!;
    expect(preview.fixes.filter((f) => f.kind === "overlap")).toHaveLength(1);
    const extend = preview.fixes.filter((f) => f.kind === "extend");
    expect(extend.length).toBeGreaterThan(0);
    await vm.applyBatchFixes(extend);
    expect(vm.state.batchFix).toBeNull();
    expect(vm.state.notice).toContain("没有可安全执行");
    expect(vm.state.issues.some((i) => i.type === "overlap")).toBe(true);
  });

  it("applies the overlap fix and keeps the follow-up extension working in the same run", async () => {
    const cues = [cue(1, 0, 2000), cue(2, 1600, 1900), cue(3, 5000, 6000)];
    const vm = await vmWith(cues);
    const ready = vm.previewBatchFixes()!.fixes.filter((f) => f.actions);
    await vm.applyBatchFixes(ready);
    const remaining = vm.state.issues.map((i) => i.type);
    expect(remaining).not.toContain("overlap");
    expect(remaining).not.toContain("too-short");
  });

  it("rollback to the before snapshot reproduces the original issues", async () => {
    const vm = await vmWith([cue(1, 0, 300), cue(2, 2000, 3000)]);
    const [fix] = vm.previewBatchFixes()!.fixes;
    await vm.applyBatchFixes([fix]);
    const beforeId = vm.state.batchFix!.beforeVersionId;
    await vm.restoreVersion(beforeId);
    expect(vm.state.project!.cues[0].endMs).toBe(300);
    expect(vm.state.notice).toContain("检查结果与快照时一致");
    expect(vm.state.issues.some((i) => i.id === "cue-1:too-short")).toBe(true);
  });

  it("lists unsupported issue types separately and never changes them", async () => {
    const longText = "这是一个用于检查速度的非常长的字幕内容".repeat(3);
    const vm = await vmWith([
      cue(1, 0, 4000, ""),
      cue(2, 5000, 9000, longText),
    ]);
    const preview = vm.previewBatchFixes()!;
    expect(preview.fixes).toHaveLength(0);
    expect(preview.unsupported.map((u) => u.kind).sort()).toEqual([
      "empty",
      "too-long",
    ]);
    // 没有可执行项时 apply 直接返回
    await vm.applyBatchFixes(preview.fixes);
    expect(vm.state.project!.cues[0].text).toBe("");
  });

  it("does not let a fix introduce overlap: blocked extension keeps the issue", async () => {
    const vm = await vmWith([cue(1, 0, 300), cue(2, 900, 2000)]);
    const blockedFix = vm
      .previewBatchFixes()!
      .fixes.find((f) => f.kind === "extend")!;
    expect(blockedFix.actions).toBeNull();
    expect(blockedFix.blockedReason).toContain("需人工确认");
  });

  it("undoes an invalid-time ripple fix and restores the original invalid issue", async () => {
    const vm = await vmWith([cue(1, 2000, 1000), cue(2, 2200, 3000)]);
    const ready = vm.previewBatchFixes()!.fixes.filter((f) => f.actions);
    expect(vm.state.issues.some((i) => i.type === "invalid-time")).toBe(true);
    await vm.applyBatchFixes(ready);
    expect(vm.state.issues.some((i) => i.type === "invalid-time")).toBe(false);
    const applied = vm.state.batchFix!.fixes[0];
    await vm.undoFix(applied.id);
    expect(vm.state.project!.cues[0]).toMatchObject({
      startMs: 2000,
      endMs: 1000,
    });
    expect(vm.state.issues.some((i) => i.type === "invalid-time")).toBe(true);
  });

  it("undoes an overlap ripple fix and restores the overlap issue", async () => {
    const vm = await vmWith([
      cue(1, 0, 900),
      cue(2, 600, 1600),
      cue(3, 2000, 3000),
    ]);
    const ready = vm.previewBatchFixes()!.fixes.filter((f) => f.actions);
    await vm.applyBatchFixes(ready);
    expect(vm.state.issues.some((i) => i.type === "overlap")).toBe(false);
    const ripple = vm.state.batchFix!.fixes[0];
    await vm.undoFix(ripple.id);
    expect(vm.state.project!.cues[1].startMs).toBe(600);
    expect(vm.state.issues.some((i) => i.type === "overlap")).toBe(true);
  });

  it("undoes one fix while keeping another active fix in place", async () => {
    // 同一批里：缩短 #1 消除重叠 + 延长 #2 消除过短。
    // 只撤回延长：#1 的截短仍然生效，重叠不重现，#2 的过短问题恢复
    const vm = await vmWith([
      cue(1, 0, 2000),
      cue(2, 1600, 1900),
      cue(3, 5000, 6000),
    ]);
    const ready = vm.previewBatchFixes()!.fixes.filter((f) => f.actions);
    await vm.applyBatchFixes(ready);
    const extendFix = vm.state.batchFix!.fixes.find(
      (f) => f.kind === "extend",
    )!;
    await vm.undoFix(extendFix.id);
    expect(vm.state.project!.cues[0].endMs).toBe(1480); // 截短保留
    expect(vm.state.project!.cues[1]).toMatchObject({
      startMs: 1600,
      endMs: 1900,
    });
    expect(vm.state.issues.some((i) => i.type === "overlap")).toBe(false);
    expect(vm.state.issues.some((i) => i.type === "too-short")).toBe(true);
    expect(vm.state.notice).toContain("已撤回");
  });
});
