import { newId } from '../core/id.js';
import { scenarioFingerprint } from '../core/fingerprint.js';
import { inspections, log, now, simulationResults } from '../domain/state.js';
import type { Inspection, LoadScenario, RiskCode, RiskFinding, ScenarioInput, SimulationResult } from '../domain/types.js';

export function scenarioInput(s: LoadScenario): ScenarioInput {
  return {
    vehicleLoadKn: s.vehicleLoadKn,
    windSpeedMs: s.windSpeedMs,
    temperatureC: s.temperatureC,
    durationHours: s.durationHours,
  };
}

/** 场景当前（编辑后）输入的指纹；与已存结果指纹不同即说明结果过期 */
export function currentFingerprint(s: LoadScenario): string {
  return scenarioFingerprint(s.elementId, scenarioInput(s));
}

export function currentResult(s: LoadScenario): SimulationResult | null {
  if (!s.currentResultId) return null;
  return simulationResults.find(r => r.id === s.currentResultId) ?? null;
}

/** 结果是否仍匹配场景当前输入与目标构件；输入/构件一旦变化，旧结果立即过期 */
export function isResultFresh(s: LoadScenario, r: SimulationResult): boolean {
  return r.elementId === s.elementId && r.fingerprint === currentFingerprint(s);
}

const EVIDENCE_BY_RISK: Record<RiskCode, string[]> = {
  stress: ['photo', 'measurement', 'engineer-note'],
  displacement: ['photo', 'measurement', 'engineer-note'],
  fatigue: ['measurement', 'engineer-note', 'fatigue-report'],
};

function reasonFor(elementId: string, r: SimulationResult, f: RiskFinding): string {
  return `荷载场景 ${r.scenarioId} 对构件 ${elementId} 模拟命中 ${f.code} 规则（${f.severity}，比值 ${f.ratio}）：${f.message}`;
}

/**
 * 按风险规则同步检修任务：每个风险代码对应一个任务。
 * 同一指纹的重复模拟复用已有未关闭任务（幂等，不重复建单）；
 * 指纹变化（输入或目标构件改变）后旧任务不再被复用。
 */
export function syncRiskInspections(s: LoadScenario, r: SimulationResult): { finding: RiskFinding; inspection: Inspection; action: 'created' | 'existing' }[] {
  const outcomes: { finding: RiskFinding; inspection: Inspection; action: 'created' | 'existing' }[] = [];
  for (const f of r.risks) {
    const existing = inspections.find(
      x => x.status === 'planned' && x.source === 'risk-rule'
        && x.scenarioId === s.id && x.elementId === r.elementId
        && x.riskCode === f.code && x.resultFingerprint === r.fingerprint,
    );
    if (existing) {
      outcomes.push({ finding: f, inspection: existing, action: 'existing' });
      continue;
    }
    const inspection: Inspection = {
      id: newId(),
      elementId: r.elementId,
      reason: reasonFor(r.elementId, r, f),
      priority: f.severity === 'critical' ? 'high' : 'medium',
      status: 'planned',
      requestedAt: now(),
      requiredEvidence: EVIDENCE_BY_RISK[f.code],
      source: 'risk-rule',
      riskCode: f.code,
      scenarioId: s.id,
      resultFingerprint: r.fingerprint,
      resultId: r.id,
    };
    inspections.push(inspection);
    log('inspection.risk-create', inspection.id, { scenarioId: s.id, resultId: r.id, riskCode: f.code, severity: f.severity });
    outcomes.push({ finding: f, inspection, action: 'created' });
  }
  return outcomes;
}

/** 场景视图：附带当前结果与过期标记，方便检查人员直接判断结果是否可用 */
export function scenarioView(s: LoadScenario) {
  const result = currentResult(s);
  const stale = result ? !isResultFresh(s, result) : false;
  return {
    ...s,
    currentResult: result,
    stale,
    linkedInspections: result
      ? inspections.filter(x => x.scenarioId === s.id && x.resultFingerprint === result.fingerprint)
      : [],
  };
}
