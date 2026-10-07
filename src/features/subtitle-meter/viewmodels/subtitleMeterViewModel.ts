import {
  planBatchFixes,
  replayActions,
  changesBetween,
} from "../analyzers/batchFixer";
import { detectIssues } from "../analyzers/issueDetector";
import { formatSubtitles } from "../formatters/subtitleFormatter";
import {
  emptyState,
  type AppliedFix,
  type BatchFixState,
  type FixAction,
  type Format,
  type MeterState,
  type ProposedFix,
  type SubtitleCue,
  type SubtitleIssue,
  type SubtitleProject,
} from "../models";
import { detectFormat, parseSubtitles } from "../parsers/subtitleParser";
import { projectRepository } from "../repositories/projectRepository";
import { downloadSubtitles } from "../services/exportService";
import { readTextFile } from "../services/fileService";

export interface BatchFixPreview {
  fixes: ProposedFix[];
  unsupported: ReturnType<typeof planBatchFixes>["unsupported"];
}

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
  ) {
    project.updatedAt = Date.now();
    const issues = detectIssues(project.cues);
    this.publish({ project, issues, phase, notice: "" });
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
  /** 纯计算：给出当前问题的批量修正建议，不改动数据 */
  previewBatchFixes(): BatchFixPreview | null {
    const project = this.state.project;
    if (!project) return null;
    return planBatchFixes(project.cues, this.state.issues);
  }
  /** 动作的逆操作（set 记录原值；ripple 反向平移） */
  private invertActions(
    actions: FixAction[],
    before: AppliedFix["before"],
  ): FixAction[] {
    const beforeMap = new Map(before.map((change) => [change.cueId, change]));
    const inverted: FixAction[] = [];
    for (const action of actions) {
      if (action.type === "ripple")
        inverted.push({
          type: "ripple",
          fromId: action.fromId,
          deltaMs: -action.deltaMs,
        });
      else {
        const old = beforeMap.get(action.cueId);
        inverted.push({
          type: "set",
          cueId: action.cueId,
          startMs: old?.before.startMs,
          endMs: old?.before.endMs,
        });
      }
    }
    return inverted.reverse();
  }
  /** 执行选中的建议：从当前时间轴逐条重放，因前置取消而失效的跳过并说明 */
  async applyBatchFixes(fixes: ProposedFix[]) {
    const project = this.state.project;
    if (!project || !fixes.length) return;
    const planIssueIds = this.state.issues.map((issue) => issue.id);
    // 不支持自动处理的清单在改动前固定下来，执行后仍要原样展示
    const unsupported = planBatchFixes(
      project.cues,
      this.state.issues,
    ).unsupported;
    const beforeSnapshot = {
      id: `v-${Date.now()}-before`,
      label: `批量修正前 · ${new Date().toLocaleTimeString()}`,
      savedAt: Date.now(),
      cues: structuredClone(project.cues),
      issueIds: planIssueIds,
      kind: "batch-before" as const,
    };
    let working = structuredClone(project.cues);
    const applied: AppliedFix[] = [];
    const skipped: BatchFixState["skipped"] = [];
    for (const fix of fixes) {
      if (!fix.actions) continue;
      const updated = replayActions(working, fix.actions);
      if (!updated) {
        skipped.push({
          id: fix.id,
          title: fix.title,
          detail: fix.detail,
          reason:
            "此前未执行的相邻修正使该改动不再安全，已跳过；问题保留，请单独处理",
        });
        continue;
      }
      applied.push({
        id: fix.id,
        kind: fix.kind,
        cueId: fix.cueId,
        title: fix.title,
        detail: fix.detail,
        actions: fix.actions,
        before: changesBetween(working, updated),
        resolvedIssueIds: fix.issueIds,
      });
      working = updated;
    }
    if (!applied.length) {
      this.publish({
        notice: "没有可安全执行的修正，问题均已保留",
      });
      return;
    }
    const updatedProject: SubtitleProject = {
      ...project,
      cues: working,
      versions: [...project.versions, beforeSnapshot],
    };
    await this.commit(updatedProject);
    const afterIssues = detectIssues(working);
    const afterSnapshot = {
      id: `v-${Date.now()}-after`,
      label: `批量修正后 · ${new Date().toLocaleTimeString()}`,
      savedAt: Date.now(),
      cues: structuredClone(working),
      issueIds: afterIssues.map((issue) => issue.id),
      kind: "batch-after" as const,
    };
    const finalProject = {
      ...updatedProject,
      versions: [...updatedProject.versions, afterSnapshot],
    };
    const batchFix: BatchFixState = {
      planIssueIds,
      fixes: applied,
      skipped,
      unsupported,
      beforeVersionId: beforeSnapshot.id,
      afterVersionId: afterSnapshot.id,
      appliedAt: Date.now(),
    };
    await this.commit(finalProject, "ready");
    this.publish({
      batchFix,
      notice: `已批量修正 ${applied.length} 项${
        skipped.length ? `，${skipped.length} 项因相邻关系变化跳过` : ""
      }；前后各已自动留存快照`,
    });
  }
  /** 撤回单条修正：逆操作重放 + 校验未被手动改过、不产生原问题之外的新问题 */
  async undoFix(fixId: string) {
    const project = this.state.project;
    const batchFix = this.state.batchFix;
    const fix = batchFix?.fixes.find((item) => item.id === fixId);
    if (!project || !batchFix || !fix || fix.undone) return;

    // 1) 受影响条目自执行后若被手动编辑过，逆操作会覆盖手改，拒绝
    const currentMap = new Map(project.cues.map((cue) => [cue.id, cue]));
    const tampered = fix.before.filter((change) => {
      const cue = currentMap.get(change.cueId);
      return (
        !cue ||
        cue.startMs !== change.after.startMs ||
        cue.endMs !== change.after.endMs
      );
    });
    if (tampered.length) {
      this.publish({
        notice: `「${fix.title}」涉及的条目之后被手动改过，单条撤回会覆盖手改；请改用版本快照整体回退`,
      });
      return;
    }

    const inverse = this.invertActions(fix.actions, fix.before);
    const reverted = replayActions(project.cues, inverse, { inverse: true });
    if (!reverted) {
      this.publish({
        notice: `「${fix.title}」当前已无法安全撤回（相邻条目变化），请改用版本快照整体回退`,
      });
      return;
    }

    // 2) 撤回后只允许"该修正原本消除的问题"重新出现，不得产生新问题
    const beforeIds = new Set(detectIssues(project.cues).map((i) => i.id));
    const afterRevert = detectIssues(reverted);
    const allowed = new Set([
      ...beforeIds,
      ...fix.resolvedIssueIds,
      ...batchFix.fixes
        .filter((other) => !other.undone && other.id !== fix.id)
        .flatMap((other) => other.resolvedIssueIds),
    ]);
    const unexpected = afterRevert.filter((issue) => !allowed.has(issue.id));
    if (unexpected.length) {
      this.publish({
        notice: `撤回「${fix.title}」会牵动相邻条目产生 ${unexpected.length} 个新问题，已阻止；请改用版本快照整体回退`,
      });
      return;
    }

    const fixes = batchFix.fixes.map((item) =>
      item.id === fixId ? { ...item, undone: true } : item,
    );
    await this.commit({ ...project, cues: reverted }, "ready");
    this.publish({
      batchFix: { ...batchFix, fixes },
      notice: `已撤回「${fix.title}」，对应问题已恢复`,
    });
  }
  /** 收起批量修正结果面板（问题列表仍在） */
  dismissBatchFix() {
    this.publish({ batchFix: null });
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
        batchFix: null,
      });
      await this.commit(project, "ready");
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
    await this.commit({ ...this.state.project, cues });
  }
  async saveVersion() {
    const project = this.state.project;
    if (!project) return;
    const versions = [
      ...project.versions,
      {
        id: `v-${Date.now()}`,
        label: `快照 ${project.versions.filter((v) => v.kind !== "batch-before" && v.kind !== "batch-after").length + 1}`,
        savedAt: Date.now(),
        cues: structuredClone(project.cues),
        issueIds: detectIssues(project.cues).map((issue) => issue.id),
        kind: "manual" as const,
      },
    ];
    await this.commit({ ...project, versions });
    this.publish({ notice: "已保存版本快照" });
  }
  async restoreVersion(id: string) {
    const project = this.state.project,
      version = project?.versions.find((item) => item.id === id);
    if (!project || !version) return;
    const cues = structuredClone(version.cues);
    await this.commit({ ...project, cues });
    // 快照回退后检查结果必须与当时一致：用问题指纹核对
    if (version.issueIds) {
      const current = detectIssues(cues).map(
        (issue: SubtitleIssue) => issue.id,
      );
      const same =
        current.length === version.issueIds.length &&
        current.every((issueId) => version.issueIds!.includes(issueId));
      this.publish({
        batchFix: null,
        notice: same
          ? `已恢复${version.label}，检查结果与快照时一致（${current.length} 项问题）`
          : `已恢复${version.label}，但检查结果与快照时不一致，请重新核对`,
      });
    } else {
      this.publish({ batchFix: null, notice: `已恢复${version.label}` });
    }
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
