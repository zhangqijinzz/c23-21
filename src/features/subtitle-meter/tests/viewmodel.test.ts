import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubtitleMeterViewModel } from "../viewmodels/subtitleMeterViewModel";
import { readTextFile } from "../services/fileService";
import { downloadSubtitles } from "../services/exportService";
vi.mock("../services/fileService", () => ({
  readTextFile: vi.fn(
    async () => "1\n00:00:01,000 --> 00:00:03,000\nOriginal caption",
  ),
}));
vi.mock("../repositories/projectRepository", () => ({
  projectRepository: {
    save: vi.fn(async () => undefined),
    load: vi.fn(async () => null),
  },
}));
vi.mock("../services/exportService", () => ({ downloadSubtitles: vi.fn() }));
describe("SubtitleMeterViewModel", () => {
  let vm: SubtitleMeterViewModel;
  beforeEach(() => {
    vm = new SubtitleMeterViewModel();
  });
  it("imports, edits, rechecks, snapshots, and exports", async () => {
    await vm.importFile(new File(["x"], "clip.srt"));
    expect(vm.state.phase).toBe("ready");
    const cue = vm.state.project!.cues[0];
    await vm.editCue(cue.id, { text: "Edited" });
    expect(vm.state.project!.cues[0].text).toBe("Edited");
    await vm.saveVersion();
    expect(vm.state.project!.versions).toHaveLength(1);
    await vm.exportFile();
    expect(vm.state.notice).toBe("字幕文件已导出");
  });
  it("keeps a recoverable error when an unsupported import is selected", async () => {
    await vm.importFile(new File(["x"], "clip.txt"));
    expect(vm.state.phase).toBe("error");
    expect(vm.state.notice).toContain("仅支持");
  });
  it("shows a parse failure as a recoverable import error", async () => {
    vi.mocked(readTextFile).mockResolvedValueOnce("not a subtitle block");
    await vm.importFile(new File(["x"], "clip.srt"));
    expect(vm.state.phase).toBe("error");
    expect(vm.state.notice).toContain("缺少时间码");
  });
  it("keeps editing visible immediately and reports export failures", async () => {
    await vm.importFile(new File(["x"], "clip.srt"));
    const cue = vm.state.project!.cues[0];
    const saving = vm.editCue(cue.id, { text: "Immediate edit" });
    expect(vm.state.project!.cues[0].text).toBe("Immediate edit");
    await saving;
    vi.mocked(downloadSubtitles).mockImplementationOnce(() => {
      throw new Error("download unavailable");
    });
    await vm.exportFile();
    expect(vm.state.phase).toBe("error");
    expect(vm.state.notice).toContain("导出失败");
    expect(vm.state.project!.cues[0].text).toBe("Immediate edit");
  });
  it("previews, applies, and undoes batch fixes one item at a time", async () => {
    vi.mocked(readTextFile).mockResolvedValueOnce(
      [
        "1",
        "00:00:00,000 --> 00:00:02,000",
        "第一条普通长度的字幕",
        "",
        "2",
        "00:00:02,050 --> 00:00:03,000",
        "短",
        "",
        "3",
        "00:00:04,500 --> 00:00:06,000",
        "第三条普通长度的字幕",
      ].join("\n"),
    );
    await vm.importFile(new File(["x"], "batch.srt"));
    const beforeCues = structuredClone(vm.state.project!.cues);
    const beforeIssues = vm.state.issues;
    expect(beforeIssues.some((i) => i.type === "gap-too-narrow")).toBe(true);

    vm.previewBatchFixes();
    expect(vm.state.batchPlan?.proposals.length).toBeGreaterThan(0);
    const previewIds = new Set(vm.state.batchPlan!.proposals.map((p) => p.id));
    const firstProposal = vm.state.batchPlan!.proposals[0];
    expect(firstProposal.change).not.toBe("");
    // 预览阶段数据尚未落地
    expect(vm.state.project!.cues).toEqual(beforeCues);

    await vm.applyBatchFixes();
    expect(vm.state.project!.versions.at(-1)?.kind).toBe("before-batch-fix");
    expect(vm.state.appliedFixes.map((f) => f.id)).toEqual(
      expect.arrayContaining([...previewIds]),
    );
    const appliedCue = vm.state.project!.cues.find(
      (c) => c.id === firstProposal.cueId,
    )!;
    expect(appliedCue.startMs).toBe(firstProposal.after.startMs);

    // 逐条撤回：只恢复对应条目，其它修正保留
    await vm.undoAppliedFix(firstProposal.id);
    const undoneCue = vm.state.project!.cues.find(
      (c) => c.id === firstProposal.cueId,
    )!;
    const original = beforeCues.find((c) => c.id === firstProposal.cueId)!;
    expect(undoneCue.startMs).toBe(original.startMs);
    expect(undoneCue.endMs).toBe(original.endMs);
    expect(vm.state.appliedFixes.some((f) => f.id === firstProposal.id)).toBe(
      false,
    );
    const stillFixed = vm.state.appliedFixes[0];
    if (stillFixed) {
      const cue = vm.state.project!.cues.find(
        (c) => c.id === stillFixed.cueId,
      )!;
      expect(cue.endMs).toBe(stillFixed.after.endMs);
    }

    // 回退执行前快照：cues 与检查结果均与修正前一致
    const snapshot = vm.state.project!.versions.at(-1)!;
    await vm.restoreVersion(snapshot.id);
    expect(vm.state.project!.cues).toEqual(beforeCues);
    expect(vm.state.issues.map((i) => `${i.cueId}|${i.type}`).sort()).toEqual(
      beforeIssues.map((i) => `${i.cueId}|${i.type}`).sort(),
    );
    expect(vm.state.appliedFixes).toHaveLength(0);
    expect(vm.state.batchPlan).toBeNull();
  });
  it("lists manual issue types in the plan instead of applying them", async () => {
    vi.mocked(readTextFile).mockResolvedValueOnce(
      [
        "1",
        "00:00:00,000 --> 00:00:01,000",
        "",
        "",
        "2",
        "00:00:02,000 --> 00:00:03,000",
        "这是一段超过四十二个字的超长字幕内容用于触发警告请勿自动修改谢谢".repeat(
          3,
        ),
      ].join("\n"),
    );
    await vm.importFile(new File(["x"], "manual.srt"));
    vm.previewBatchFixes();
    const plan = vm.state.batchPlan!;
    // 文本类问题永远不会被自动修正
    expect(plan.proposals.some((p) => p.issueLabels.includes("文本超长"))).toBe(
      false,
    );
    const unresolvedTypes = plan.unresolved.map((u) => u.type);
    expect(unresolvedTypes).toContain("empty");
    expect(unresolvedTypes).toContain("too-long");
  });
});
