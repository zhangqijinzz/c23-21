import { useMemo, useState } from "react";
import { UNSUPPORTED_REASONS } from "../analyzers/batchFixer";
import type { BatchFixState, ProposedFix } from "../models";
import type { SubtitleMeterViewModel } from "../viewmodels/subtitleMeterViewModel";

const kindLabel: Record<ProposedFix["kind"], string> = {
  "invalid-time": "时间无效",
  overlap: "重叠",
  "gap-narrow": "间隔过窄",
  extend: "停留/节奏",
};

/** 执行前的建议预览：勾选、逐条展示改动、放不下与不支持的分组列出 */
export function BatchFixPreview({
  vm,
  planToken,
}: {
  vm: SubtitleMeterViewModel;
  planToken: string;
}) {
  const plan = useMemo(() => {
    // planToken 变化（问题或时间轴变化）时重新生成建议
    void planToken;
    return vm.previewBatchFixes();
  }, [vm, planToken]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // 计划随问题变化重新生成时，勾选重置
  const [seenToken, setSeenToken] = useState(planToken);
  if (seenToken !== planToken) {
    setSeenToken(planToken);
    setSelected(new Set());
  }
  if (!plan || (!plan.fixes.length && !plan.unsupported.length)) return null;

  const ready = plan.fixes.filter((fix) => fix.actions);
  const blocked = plan.fixes.filter((fix) => !fix.actions);
  const allSelected =
    ready.length > 0 && ready.every((fix) => selected.has(fix.id));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const chosen = ready.filter((fix) => selected.has(fix.id));

  return (
    <div className="batch-fix-card">
      <div className="batch-fix-head">
        <strong>批量修正建议</strong>
        <span>
          {ready.length} 项可自动处理 · {blocked.length} 项放不下 ·{" "}
          {plan.unsupported.length} 项不支持自动处理
        </span>
      </div>

      {ready.length > 0 && (
        <div className="batch-fix-list">
          <label className="batch-fix-row select-all">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() =>
                setSelected(
                  allSelected ? new Set() : new Set(ready.map((f) => f.id)),
                )
              }
            />
            <span>全选可自动处理的修正</span>
          </label>
          {ready.map((fix) => (
            <label key={fix.id} className="batch-fix-row" title={fix.detail}>
              <input
                type="checkbox"
                checked={selected.has(fix.id)}
                onChange={() => toggle(fix.id)}
              />
              <span className="fix-kind">{kindLabel[fix.kind]}</span>
              <span className="fix-body">
                <strong>{fix.title}</strong>
                <small>{fix.detail}</small>
              </span>
            </label>
          ))}
        </div>
      )}

      {blocked.length > 0 && (
        <div className="batch-fix-blocked">
          <div className="batch-fix-subhead">放不下，问题已保留</div>
          {blocked.map((fix) => (
            <div key={fix.id} className="batch-fix-row blocked">
              <span className="fix-kind">{kindLabel[fix.kind]}</span>
              <span className="fix-body">
                <strong>{fix.title}</strong>
                <small>{fix.blockedReason}</small>
              </span>
            </div>
          ))}
        </div>
      )}

      {plan.unsupported.length > 0 && (
        <div className="batch-fix-unsupported">
          <div className="batch-fix-subhead">
            不支持自动处理（不会被修改，需人工处理）
          </div>
          {plan.unsupported.map((item) => (
            <div key={item.issueId} className="batch-fix-row unsupported">
              <span className="fix-kind">
                {item.kind === "empty" ? "文本为空" : "行太长"}
              </span>
              <span className="fix-body">
                <strong>
                  #{item.index} ·{" "}
                  {item.message || UNSUPPORTED_REASONS[item.kind]}
                </strong>
                <small>{item.reason}</small>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="batch-fix-actions">
        <button
          className="export-button"
          disabled={!chosen.length}
          onClick={() => void vm.applyBatchFixes(chosen)}
        >
          执行 {chosen.length} 项修正（自动留存前后快照）
        </button>
        <small>
          修正会保证不顶掉下一条、不制造新重叠；无法满足的条目保持原样
        </small>
      </div>
    </div>
  );
}

/** 执行后的结果面板：已应用逐条撤回、跳过与不支持的原因、快照入口 */
export function BatchFixResult({
  vm,
  batchFix,
}: {
  vm: SubtitleMeterViewModel;
  batchFix: BatchFixState;
}) {
  const active = batchFix.fixes.filter((fix) => !fix.undone);
  const undone = batchFix.fixes.filter((fix) => fix.undone);
  return (
    <div className="batch-fix-card result">
      <div className="batch-fix-head">
        <strong>批量修正结果</strong>
        <button className="link-button" onClick={() => vm.dismissBatchFix()}>
          收起
        </button>
      </div>
      <div className="batch-fix-list">
        {active.map((fix) => (
          <div key={fix.id} className="batch-fix-row applied">
            <span className="fix-kind">{kindLabel[fix.kind]}</span>
            <span className="fix-body">
              <strong>{fix.title}</strong>
              <small>{fix.detail}</small>
            </span>
            <button
              className="secondary-button undo-button"
              onClick={() => void vm.undoFix(fix.id)}
            >
              撤回
            </button>
          </div>
        ))}
        {undone.map((fix) => (
          <div key={fix.id} className="batch-fix-row undone">
            <span className="fix-kind">{kindLabel[fix.kind]}</span>
            <span className="fix-body">
              <strong>{fix.title}</strong>
              <small>已撤回，问题恢复</small>
            </span>
          </div>
        ))}
      </div>
      {batchFix.skipped.length > 0 && (
        <div className="batch-fix-blocked">
          <div className="batch-fix-subhead">执行时跳过（问题保留）</div>
          {batchFix.skipped.map((item) => (
            <div key={item.id} className="batch-fix-row blocked">
              <span className="fix-body">
                <strong>{item.title}</strong>
                <small>{item.reason}</small>
              </span>
            </div>
          ))}
        </div>
      )}
      {batchFix.unsupported.length > 0 && (
        <div className="batch-fix-unsupported">
          <div className="batch-fix-subhead">
            仍需人工处理（{batchFix.unsupported.length} 项，未做任何修改）
          </div>
          {batchFix.unsupported.map((item) => (
            <div key={item.issueId} className="batch-fix-row unsupported">
              <span className="fix-kind">
                {item.kind === "empty" ? "文本为空" : "行太长"}
              </span>
              <span className="fix-body">
                <strong>
                  #{item.index} · {item.message}
                </strong>
                <small>{item.reason}</small>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="batch-fix-actions">
        <button
          className="secondary-button"
          onClick={() => void vm.restoreVersion(batchFix.beforeVersionId)}
        >
          整体回退到修正前快照
        </button>
        <small>单条撤回只逆推本项；需要全部还原可回退快照</small>
      </div>
    </div>
  );
}
