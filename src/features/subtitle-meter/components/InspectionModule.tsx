import {
  formatMs,
  ISSUE_LABELS,
  MANUAL_ISSUE_TYPES,
  type AppliedFix,
  type BatchFixPlan,
} from "../analyzers/batchFixer";
import type { SubtitleCue, SubtitleIssue } from "../models";
import type { SubtitleMeterViewModel } from "../viewmodels/subtitleMeterViewModel";
export function InspectionModule({
  cues,
  issues,
  vm,
  selectedId,
  batchPlan,
  appliedFixes,
}: {
  cues: SubtitleCue[];
  issues: SubtitleIssue[];
  vm: SubtitleMeterViewModel;
  selectedId: string | null;
  batchPlan: BatchFixPlan | null;
  appliedFixes: AppliedFix[];
}) {
  const selected = cues.find((cue) => cue.id === selectedId) ?? cues[0];
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter(
    (issue) => issue.severity === "warning",
  ).length;
  const cps = selected
    ? [...selected.text.replace(/\s/g, "")].length /
      Math.max(0.1, (selected.endMs - selected.startMs) / 1000)
    : 0;
  return (
    <section className="module inspection-module">
      <div className="module-head">
        <div>
          <span className="module-kicker">03 / INSPECTION</span>
          <h2>
            问题检查 <span className="issue-count">{issues.length}</span>
          </h2>
        </div>
        <div className="issue-summary">
          <span className="error-color">{errors} 错误</span>
          <span className="warning-color">{warnings} 提醒</span>
        </div>
      </div>
      <BatchFixPanel
        issues={issues}
        vm={vm}
        batchPlan={batchPlan}
        appliedFixes={appliedFixes}
      />
      <div className="issue-list">
        {issues.length ? (
          issues.map((issue) => (
            <button
              key={issue.id}
              className={`issue-row ${issue.severity}`}
              onClick={() => vm.selectCue(issue.cueId)}
            >
              <span className="issue-bullet">
                {issue.severity === "error" ? "!" : "·"}
              </span>
              <span>{issue.message}</span>
              <span className="issue-cue">
                #{cues.find((cue) => cue.id === issue.cueId)?.index}
              </span>
            </button>
          ))
        ) : (
          <div className="clear-state">✓ 当前未发现明显问题</div>
        )}
      </div>
      {selected && (
        <div className="edit-card">
          <div className="edit-title">
            <span>当前条目 · #{selected.index}</span>
            <span className={cps > 18 ? "warning-color" : ""}>
              {cps.toFixed(1)} 字/秒
            </span>
          </div>
          <textarea
            aria-label="字幕文本"
            value={selected.text}
            onChange={(e) =>
              void vm.editCue(selected.id, { text: e.target.value })
            }
            rows={Math.min(4, Math.max(2, selected.text.split("\n").length))}
          />
          <div className="time-edit">
            <label>
              开始
              <input
                aria-label="开始时间毫秒"
                type="number"
                min="0"
                step="100"
                value={selected.startMs}
                onChange={(e) =>
                  void vm.editCue(selected.id, {
                    startMs: Number(e.target.value),
                  })
                }
              />
            </label>
            <span>→</span>
            <label>
              结束
              <input
                aria-label="结束时间毫秒"
                type="number"
                min="0"
                step="100"
                value={selected.endMs}
                onChange={(e) =>
                  void vm.editCue(selected.id, {
                    endMs: Number(e.target.value),
                  })
                }
              />
            </label>
          </div>
        </div>
      )}
    </section>
  );
}

function BatchFixPanel({
  issues,
  vm,
  batchPlan,
  appliedFixes,
}: {
  issues: SubtitleIssue[];
  vm: SubtitleMeterViewModel;
  batchPlan: BatchFixPlan | null;
  appliedFixes: AppliedFix[];
}) {
  return (
    <div className="batch-fix">
      <div className="batch-fix-bar">
        <div>
          <strong>批量修正</strong>
          <small>自动处理重叠、间隔不足、停留过短、阅读过快</small>
        </div>
        {batchPlan ? (
          <button
            className="secondary-button"
            onClick={() => vm.dismissBatchFixPreview()}
          >
            收起预览
          </button>
        ) : (
          <button
            className="secondary-button"
            disabled={issues.length === 0}
            onClick={() => vm.previewBatchFixes()}
          >
            生成修正建议
          </button>
        )}
      </div>

      {appliedFixes.length > 0 && (
        <div className="batch-group">
          <div className="batch-group-title">
            已执行的自动修正（{appliedFixes.length}）· 可逐条撤回
          </div>
          {appliedFixes.map((fix) => (
            <div key={fix.id} className="fix-row applied">
              <button
                className="fix-detail"
                onClick={() => vm.selectCue(fix.cueId)}
              >
                <span className="fix-head">
                  第 {fix.cueIndex} 条 · {fix.issueLabels.join("、")}
                </span>
                <span className="fix-times">
                  {formatMs(fix.before.startMs)}–{formatMs(fix.before.endMs)} →{" "}
                  {formatMs(fix.after.startMs)}–{formatMs(fix.after.endMs)}
                </span>
              </button>
              <button
                className="undo-button"
                onClick={() => void vm.undoAppliedFix(fix.id)}
              >
                撤回
              </button>
            </div>
          ))}
          {batchPlan && (
            <p className="batch-rename-tip">
              撤回部分修正后请重新「生成修正建议」，以便依据当前时间轴重算。
            </p>
          )}
        </div>
      )}

      {batchPlan && batchPlan.proposals.length > 0 && (
        <div className="batch-group">
          <div className="batch-group-title">
            将执行的修正（{batchPlan.proposals.length}）· 执行前自动留快照
          </div>
          {batchPlan.proposals.map((proposal) => (
            <button
              key={proposal.id}
              className="fix-row proposal"
              onClick={() => vm.selectCue(proposal.cueId)}
            >
              <span className="fix-detail">
                <span className="fix-head">
                  第 {proposal.cueIndex} 条 · {proposal.issueLabels.join("、")}
                </span>
                <span className="fix-times">
                  {formatMs(proposal.before.startMs)}–
                  {formatMs(proposal.before.endMs)} →{" "}
                  {formatMs(proposal.after.startMs)}–
                  {formatMs(proposal.after.endMs)}（{proposal.change}）
                </span>
              </span>
            </button>
          ))}
          <div className="batch-actions">
            <button
              className="apply-fix-button"
              onClick={() => void vm.applyBatchFixes()}
            >
              执行 {batchPlan.proposals.length} 项修正
            </button>
            <span className="batch-safe-tip">
              相邻条目边界已校验，不会顶掉下一条或产生新重叠
            </span>
          </div>
        </div>
      )}

      {batchPlan && batchPlan.unresolved.length > 0 && (
        <div className="batch-group manual-group">
          <div className="batch-group-title">
            无法自动处理（{batchPlan.unresolved.length}）· 仍需人工修改
          </div>
          {batchPlan.unresolved.map((item) => (
            <button
              key={item.issueId}
              className="fix-row unresolved"
              onClick={() => vm.selectCue(item.cueId)}
            >
              <span className="fix-detail">
                <span className="fix-head">
                  第 {item.cueIndex} 条 · {ISSUE_LABELS[item.type]}：
                  {item.message}
                </span>
                <span className="fix-reason">原因：{item.reason}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      <details className="manual-types">
        <summary>哪些问题不会被批量修正？</summary>
        <ul>
          {MANUAL_ISSUE_TYPES.map((item) => (
            <li key={item.type}>
              <strong>{item.label}</strong>：{item.hint}
            </li>
          ))}
          <li>
            <strong>放不下的时间类问题</strong>：相邻条目之间没有足够空间时
            保留原问题并说明原因，不会强行覆盖。
          </li>
        </ul>
      </details>
    </div>
  );
}
