import { detectIssues } from "../analyzers/issueDetector";
import { buildBatchFixPlan, type AppliedFix } from "../analyzers/batchFixer";
import { formatSubtitles } from "../formatters/subtitleFormatter";
import {
  emptyState,
  type Format,
  type MeterState,
  type SubtitleCue,
  type SubtitleProject,
} from "../models";
import { detectFormat, parseSubtitles } from "../parsers/subtitleParser";
import { projectRepository } from "../repositories/projectRepository";
import { downloadSubtitles } from "../services/exportService";
import { readTextFile } from "../services/fileService";
export class SubtitleMeterViewModel {
  state: MeterState = emptyState();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.state;
  private publish(patch: Partial<MeterState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private async commit(
    project: SubtitleProject,
    phase: MeterState["phase"] = "editing",
    patch: Partial<MeterState> = {},
  ) {
    project.updatedAt = Date.now();
    const issues = detectIssues(project.cues);
    this.publish({ project, issues, phase, notice: "", ...patch });
    try {
      await projectRepository.save(project);
    } catch {
      if (this.state.project?.updatedAt === project.updatedAt) {
        this.publish({
          phase: "error",
          notice: "本地保存失败；当前修改仍保留在页面中，请导出备份",
        });
      }
    }
  }
  async restore() {
    try {
      const project = await projectRepository.load();
      if (project)
        this.publish({
          project,
          issues: detectIssues(project.cues),
          phase: "ready",
          selectedId: project.cues[0]?.id ?? null,
          notice: "已恢复上次编辑",
        });
    } catch {
      this.publish({ notice: "本地项目暂时无法读取，可继续导入字幕文件" });
    }
  }
  async importFile(file: File) {
    this.publish({ phase: "importing", notice: "正在读取并解析字幕文件…" });
    try {
      const format = detectFormat(file.name),
        text = await readTextFile(file),
        cues = parseSubtitles(text, format);
      const project: SubtitleProject = {
        id: "subtitle-meter.current.v1",
        name: file.name,
        format,
        cues,
        updatedAt: Date.now(),
        versions: [],
      };
      this.publish({
        selectedId: cues[0].id,
        notice: `已解析 ${cues.length} 条字幕`,
        batchPlan: null,
        appliedFixes: [],
      });
      await this.commit(project, "ready", {
        batchPlan: null,
        appliedFixes: [],
      });
    } catch (error) {
      this.publish({
        phase: "error",
        notice:
          error instanceof Error ? error.message : "导入失败，请检查文件后重试",
      });
    }
  }
  selectCue(id: string) {
    this.publish({ selectedId: id });
  }
  setZoom(zoom: number) {
    this.publish({ zoom });
  }
  async editCue(
    id: string,
    patch: Partial<Pick<SubtitleCue, "text" | "startMs" | "endMs">>,
  ) {
    if (!this.state.project) return;
    const cues = this.state.project.cues.map((cue) =>
      cue.id === id ? { ...cue, ...patch } : cue,
    );
    // 手动改动后旧方案可能不再成立，丢弃预览；已执行的修正仍可逐条撤回
    await this.commit({ ...this.state.project, cues }, "editing", {
      batchPlan: null,
    });
  }
  previewBatchFixes() {
    const project = this.state.project;
    if (!project) return;
    this.publish({
      batchPlan: buildBatchFixPlan(project.cues, this.state.issues),
      notice: "",
    });
  }
  dismissBatchFixPreview() {
    this.publish({ batchPlan: null });
  }
  async applyBatchFixes() {
    const project = this.state.project;
    const plan = this.state.batchPlan;
    if (!project || !plan || plan.proposals.length === 0) return;
    const savedAt = Date.now(),
      snapshot = {
        id: `v-${savedAt}`,
        label: `批量修正前 ${new Date(savedAt).toLocaleTimeString()}`,
        savedAt,
        cues: structuredClone(project.cues),
        kind: "before-batch-fix" as const,
      };
    const appliedAt = Date.now();
    const appliedFixes: AppliedFix[] = [
      ...this.state.appliedFixes,
      ...plan.proposals.map((proposal) => ({ ...proposal, appliedAt })),
    ];
    // 执行前自动留快照，回退后检查结果与修正前完全一致（快照包含完整 cues）
    const nextProject = {
      ...project,
      cues: structuredClone(plan.cues),
      versions: [...project.versions, snapshot],
    };
    await this.commit(nextProject, "editing");
    const remaining = this.state.issues.length;
    this.publish({
      appliedFixes,
      batchPlan: { ...plan, proposals: [] },
      notice:
        `已自动修正 ${plan.proposals.length} 项` +
        (remaining ? `，仍有 ${remaining} 项需要人工处理` : "，未发现遗留问题"),
    });
  }
  async undoAppliedFix(fixId: string) {
    const project = this.state.project;
    const fix = this.state.appliedFixes.find((item) => item.id === fixId);
    if (!project || !fix) return;
    const cues = project.cues.map((cue) =>
      cue.id === fix.cueId
        ? { ...cue, startMs: fix.before.startMs, endMs: fix.before.endMs }
        : cue,
    );
    const appliedFixes = this.state.appliedFixes.filter(
      (item) => item.id !== fixId,
    );
    await this.commit({ ...project, cues }, "editing", { appliedFixes });
    this.publish({ notice: `已撤回第 ${fix.cueIndex} 条的自动修正` });
  }
  async saveVersion() {
    const project = this.state.project;
    if (!project) return;
    const versions = [
      ...project.versions,
      {
        id: `v-${Date.now()}`,
        label: `快照 ${project.versions.length + 1}`,
        savedAt: Date.now(),
        cues: structuredClone(project.cues),
      },
    ];
    await this.commit({ ...project, versions });
    this.publish({ notice: "已保存版本快照" });
  }
  async restoreVersion(id: string) {
    const project = this.state.project,
      version = project?.versions.find((item) => item.id === id);
    if (!project || !version) return;
    // 回退后基于快照 cues 重新检测，结果与快照保存时一致；批量修正上下文同步失效
    await this.commit(
      { ...project, cues: structuredClone(version.cues) },
      "editing",
      { batchPlan: null, appliedFixes: [] },
    );
    this.publish({ notice: `已恢复${version.label}，检查结果已同步` });
  }
  async exportFile() {
    const project = this.state.project;
    if (!project) return;
    this.publish({ phase: "exporting" });
    try {
      formatSubtitles(project.cues, project.format);
      downloadSubtitles(project.name, project.cues, project.format);
      this.publish({ phase: "ready", notice: "字幕文件已导出" });
    } catch {
      this.publish({
        phase: "error",
        notice: "导出失败，编辑内容已保留，请重试",
      });
    }
  }
  setFormat(format: Format) {
    const project = this.state.project;
    if (project) void this.commit({ ...project, format });
  }
}
export const createViewModel = () => new SubtitleMeterViewModel();
