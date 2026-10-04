import { newId } from '../core/id.js';
import type { FastifyInstance } from 'fastify';
import { elements, inspections, loadScenarios, log, now, simulationResults } from '../domain/state.js';
import type { Inspection } from '../domain/types.js';
import { currentFingerprint, currentResult, isResultFresh } from '../services/inspections.js';

function inspectionView(i: Inspection) {
  const scenario = i.scenarioId ? loadScenarios.find(s => s.id === i.scenarioId) : undefined;
  const linkedResult = i.resultId ? simulationResults.find(r => r.id === i.resultId) : undefined;
  const linkedStale = scenario && linkedResult ? !isResultFresh(scenario, linkedResult) : false;
  return {
    ...i,
    scenario: scenario
      ? {
          id: scenario.id,
          name: scenario.name,
          elementId: scenario.elementId,
          status: scenario.status,
          linkedResultStale: linkedStale,
        }
      : null,
  };
}

export async function registerInspectionRoutes(app: FastifyInstance) {
  // 直接检修流程：不经过模拟，人工发起
  app.post('/api/inspections', async (req: any, res: any) => {
    const b = req.body as any;
    if (!b.elementId || !b.reason) return res.code(400).send({ error: 'elementId 和 reason 必填' });
    const element = elements.find(x => x.id === b.elementId);
    if (!element) return res.code(404).send({ error: 'element not found' });
    const i: Inspection = {
      id: newId(),
      elementId: element.id,
      reason: String(b.reason),
      priority: b.priority || 'medium',
      status: 'planned',
      requestedAt: now(),
      requiredEvidence: b.requiredEvidence || ['photo', 'measurement', 'engineer-note'],
      source: 'manual',
    };
    inspections.push(i);
    log('inspection.create', i.id, { elementId: i.elementId, source: 'manual' });
    return inspectionView(i);
  });

  app.get('/api/inspections', async () => ({ inspections: inspections.map(inspectionView) }));

  app.get('/api/inspections/:id', async (req: any, res: any) => {
    const i = inspections.find(x => x.id === (req.params as any).id);
    if (!i) return res.code(404).send({ error: 'inspection not found' });
    return inspectionView(i);
  });

  /**
   * 关闭任务，二选一：
   *  1) evidence：证据种类必须覆盖任务要求（证据不足 => 409）
   *  2) closeWithResultId：用某场景的“新结果”关闭风险任务，
   *     结果必须仍与场景当前输入+构件一致（过期 => 409）、
   *     构件必须与任务一致且结果无残留风险（仍有风险 => 409）。
   */
  app.post('/api/inspections/:id/close', async (req: any, res: any) => {
    const i = inspections.find(x => x.id === (req.params as any).id);
    if (!i) return res.code(404).send({ error: 'inspection not found' });
    if (i.status === 'closed') return res.code(409).send({ error: 'inspection already closed' });

    const b = req.body as any;
    const hasEvidence = b.evidence != null;
    const hasResult = b.closeWithResultId != null;
    if (!hasEvidence && !hasResult) {
      return res.code(400).send({ error: '需提供 evidence 或 closeWithResultId 之一作为关闭依据' });
    }

    // 路径 1：证据关闭（人工/风险任务均适用）
    if (hasEvidence) {
      if (!Array.isArray(b.evidence) || b.evidence.length < i.requiredEvidence.length) {
        return res.code(409).send({ error: 'inspection evidence incomplete', required: i.requiredEvidence });
      }
      i.status = 'closed';
      i.evidence = b.evidence;
      i.closedBy = 'evidence';
      i.closedAt = now();
      log('inspection.close', i.id, { by: 'evidence' });
      return inspectionView(i);
    }

    // 路径 2：新结果关闭（仅风险规则任务）
    if (i.source !== 'risk-rule' || !i.scenarioId) {
      return res.code(409).send({ error: '直接检修任务只能通过证据关闭' });
    }
    const s = loadScenarios.find(x => x.id === i.scenarioId);
    if (!s) return res.code(409).send({ error: 'linked scenario not found' });
    const r = currentResult(s);
    if (!r || r.id !== b.closeWithResultId) return res.code(409).send({ error: 'result not found or not the scenario current result' });
    if (r.elementId !== i.elementId) return res.code(409).send({ error: 'result element 与任务构件不一致' });
    if (!isResultFresh(s, r)) {
      return res.code(409).send({
        error: 'stale result: 输入或目标构件已变化，旧结果不能用于关闭任务，请重新模拟',
        staleResultFingerprint: r.fingerprint,
        currentFingerprint: currentFingerprint(s),
      });
    }
    const residual = r.risks.filter(x => x.code === i.riskCode);
    if (residual.length) {
      return res.code(409).send({ error: 'result still at risk，该风险规则仍被触发，不能关闭', residual });
    }
    i.status = 'closed';
    i.closedBy = 'new-result';
    i.closedAt = now();
    log('inspection.close', i.id, { by: 'new-result', resultId: r.id });
    return inspectionView(i);
  });
}
