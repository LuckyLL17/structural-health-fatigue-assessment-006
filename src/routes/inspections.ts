import type { FastifyInstance } from 'fastify';
import { newId } from '../core/id.js';
import { elements, inspections, loadScenarios, log, now } from '../domain/state.js';
import type { Inspection, ScenarioResult } from '../domain/types.js';

function findResult(resultId: string): { scenarioId: string; result: ScenarioResult } | null {
  for (const s of loadScenarios) {
    const r = s.results.find(x => x.id === resultId);
    if (r) return { scenarioId: s.id, result: r };
  }
  return null;
}

export async function registerInspectionRoutes(app: FastifyInstance) {
  /** 直接检修流程：人工发起，不依赖模拟结果 */
  app.post('/api/inspections', async (req: any, res: any) => {
    const b = req.body as any;
    if (!b.elementId || !b.reason) return res.code(400).send({ error: 'elementId 和 reason 必填' });
    if (!elements.some(x => x.id === b.elementId)) return res.code(404).send({ error: 'element not found' });
    const i: Inspection = {
      id: newId(),
      elementId: b.elementId,
      reason: b.reason,
      priority: b.priority || 'medium',
      status: 'planned',
      requestedAt: now(),
      requiredEvidence: b.requiredEvidence || ['photo', 'measurement', 'engineer-note'],
      source: 'direct',
    };
    inspections.push(i);
    log('inspection.request', i.id, { elementId: i.elementId, reason: i.reason });
    return i;
  });

  app.get('/api/inspections', async (req: any) => {
    const q = req.query as any;
    let list = inspections.slice();
    if (q.elementId) list = list.filter(x => x.elementId === q.elementId);
    if (q.scenarioId) list = list.filter(x => x.scenarioId === q.scenarioId);
    if (q.status) list = list.filter(x => x.status === q.status);
    return { inspections: list };
  });

  app.post('/api/inspections/:id/close', async (req: any, res: any) => {
    const i = inspections.find(x => x.id === (req.params as any).id);
    if (!i) return res.code(404).send({ error: 'inspection not found' });
    if (i.status === 'closed') return res.code(409).send({ error: 'inspection already closed' });
    const b = req.body as any;

    // 证据门禁：必须覆盖全部要求的证据类型，证据不足不允许关闭
    if (!Array.isArray(b.evidence) || !i.requiredEvidence.every(e => b.evidence.includes(e))) {
      return res.code(409).send({
        code: 'inspection-evidence-insufficient',
        error: '证据不足，缺少必需的检修证据',
        provided: Array.isArray(b.evidence) ? b.evidence : [],
        required: i.requiredEvidence,
      });
    }

    // 风险规则自动创建的任务：必须用同一构件的新模拟结果证明风险解除；
    // 过期结果、构件不匹配或仍有风险的结果都不能关闭任务。
    if (i.source === 'load-simulation') {
      if (!b.resultId) {
        return res.code(409).send({
          code: 'close-result-required',
          error: '风险检修任务必须提供新的模拟结果（resultId）才能关闭',
        });
      }
      const found = findResult(b.resultId);
      if (!found) {
        return res.code(404).send({ code: 'result-not-found', error: '关闭依据的模拟结果不存在' });
      }
      const { scenarioId, result } = found;
      if (scenarioId !== i.scenarioId) {
        return res.code(409).send({ code: 'result-scenario-mismatch', error: '结果不属于该检修任务对应的荷载场景' });
      }
      if (result.elementId !== i.elementId) {
        return res.code(409).send({ code: 'result-element-mismatch', error: '结果的目标构件与检修任务不一致' });
      }
      if (result.superseded || result.id === i.resultId) {
        return res.code(409).send({
          code: 'result-stale',
          error: result.superseded ? '该结果已过期（输入或目标构件已变化），不能用于关闭任务' : '不能用创建任务时的旧结果关闭任务，需要重新模拟的新结果',
        });
      }
      if (result.risks.length) {
        return res.code(409).send({
          code: 'risk-still-present',
          error: '新结果仍命中风险规则，任务不能关闭',
          risks: result.risks,
        });
      }
      i.closeResultId = result.id;
    }

    i.status = 'closed';
    i.evidence = b.evidence;
    i.closedAt = now();
    log('inspection.close', i.id, { resultId: b.resultId ?? null, evidence: i.evidence });
    return i;
  });
}
