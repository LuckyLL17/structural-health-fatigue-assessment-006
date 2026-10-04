import type { FastifyInstance } from 'fastify';
import { newId } from '../core/id.js';
import { elements, inspections, loadScenarios, log, now } from '../domain/state.js';
import type { Element, Inspection, LoadScenario, ScenarioInput } from '../domain/types.js';
import { buildResult, inputSignature } from '../services/load-scenario.js';

const editFields = ['name', 'elementId', 'vehicleLoadKn', 'windSpeedMs', 'temperatureC', 'durationHours'] as const;
type EditField = typeof editFields[number];

function parseInput(s: LoadScenario): ScenarioInput {
  return {
    vehicleLoadKn: s.vehicleLoadKn,
    windSpeedMs: s.windSpeedMs,
    temperatureC: s.temperatureC,
    durationHours: s.durationHours,
  };
}

function priorityFor(levels: string[]): Inspection['priority'] {
  return levels.includes('critical') ? 'urgent' : 'high';
}

/**
 * 命中风险规则时创建检修任务。
 * 幂等：同一构件、同一输入签名（同一输入重复模拟）只保留一条未关闭任务，不重复建。
 */
function ensureInspectionFor(scenario: LoadScenario, result: ReturnType<typeof buildResult>): { inspection: Inspection; created: boolean } {
  const existing = inspections.find(x =>
    x.source === 'load-simulation'
    && x.scenarioId === scenario.id
    && x.inputSignature === result.inputSignature
    && x.status !== 'closed',
  );
  if (existing) return { inspection: existing, created: false };

  const inspection: Inspection = {
    id: newId(),
    elementId: result.elementId,
    reason: `荷载场景「${scenario.name}」模拟命中风险规则：${result.risks.map(r => r.message).join('；')}`,
    priority: priorityFor(result.risks.map(r => r.level)),
    status: 'planned',
    requestedAt: now(),
    requiredEvidence: ['photo', 'measurement', 'engineer-note'],
    source: 'load-simulation',
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    inputSignature: result.inputSignature,
    riskCodes: result.risks.map(r => `${r.level}:${r.code}`),
    resultId: result.id,
  };
  inspections.push(inspection);
  log('inspection.auto-create', inspection.id, { scenarioId: scenario.id, resultId: result.id, risks: inspection.riskCodes });
  return { inspection, created: true };
}

export async function registerLoadScenarioRoutes(app: FastifyInstance) {
  app.post('/api/load-scenarios', async (req: any, res: any) => {
    const b = req.body as any;
    if (!b.name || b.vehicleLoadKn == null) {
      return res.code(400).send({ error: 'name 和 vehicleLoadKn 必填' });
    }
    let element: Element | null = null;
    if (b.elementId != null) {
      element = elements.find(x => x.id === b.elementId) ?? null;
      if (!element) return res.code(404).send({ error: 'element not found' });
    }
    const ts = now();
    const s: LoadScenario = {
      id: newId(),
      name: String(b.name),
      elementId: element ? element.id : null,
      vehicleLoadKn: Number(b.vehicleLoadKn),
      windSpeedMs: Number(b.windSpeedMs || 0),
      temperatureC: Number(b.temperatureC || 20),
      durationHours: Number(b.durationHours || 1),
      status: 'draft',
      createdAt: ts,
      updatedAt: ts,
      currentResultId: null,
      results: [],
    };
    loadScenarios.push(s);
    log('load-scenario.create', s.id, { name: s.name, elementId: s.elementId });
    return s;
  });

  app.get('/api/load-scenarios', async () => ({ loadScenarios }));

  app.get('/api/load-scenarios/:id', async (req: any, res: any) => {
    const s = loadScenarios.find(x => x.id === (req.params as any).id);
    if (!s) return res.code(404).send({ error: 'scenario not found' });
    return s;
  });

  app.patch('/api/load-scenarios/:id', async (req: any, res: any) => {
    const s = loadScenarios.find(x => x.id === (req.params as any).id);
    if (!s) return res.code(404).send({ error: 'scenario not found' });
    const b = req.body as any;

    const next = {
      name: b.name ?? s.name,
      elementId: b.elementId ?? s.elementId,
      vehicleLoadKn: b.vehicleLoadKn != null ? Number(b.vehicleLoadKn) : s.vehicleLoadKn,
      windSpeedMs: b.windSpeedMs != null ? Number(b.windSpeedMs) : s.windSpeedMs,
      temperatureC: b.temperatureC != null ? Number(b.temperatureC) : s.temperatureC,
      durationHours: b.durationHours != null ? Number(b.durationHours) : s.durationHours,
    };
    if (next.elementId != null && !elements.some(x => x.id === next.elementId)) {
      return res.code(404).send({ error: 'element not found' });
    }

    const affectsResult = s.status === 'simulated'
      && (next.elementId !== s.elementId
        || next.vehicleLoadKn !== s.vehicleLoadKn
        || next.windSpeedMs !== s.windSpeedMs
        || next.temperatureC !== s.temperatureC
        || next.durationHours !== s.durationHours);

    Object.assign(s, next);
    s.updatedAt = now();

    if (affectsResult) {
      // 输入或目标构件变化：旧结果留痕但作废，场景退回草稿，旧结果不得再用于关闭任务
      for (const r of s.results) r.superseded = true;
      s.currentResultId = null;
      s.status = 'draft';
      log('load-scenario.invalidate', s.id, { reason: 'input-or-element-changed' });
    }
    log('load-scenario.update', s.id, b);
    return s;
  });

  app.post('/api/load-scenarios/:id/simulate', async (req: any, res: any) => {
    const s = loadScenarios.find(x => x.id === (req.params as any).id);
    if (!s) return res.code(404).send({ error: 'scenario not found' });
    const b = (req.body as any) || {};

    // 模拟时可补选/更换目标构件；没有关联构件则不允许模拟
    if (b.elementId !== undefined) {
      const el = elements.find(x => x.id === b.elementId);
      if (!el) return res.code(404).send({ error: 'element not found' });
      s.elementId = el.id;
    }
    if (!s.elementId) {
      return res.code(400).send({ error: '场景未关联目标构件（elementId），无法模拟' });
    }
    const element = elements.find(x => x.id === s.elementId)!;

    if (b.vehicleLoadKn != null) s.vehicleLoadKn = Number(b.vehicleLoadKn);
    if (b.windSpeedMs != null) s.windSpeedMs = Number(b.windSpeedMs);
    if (b.temperatureC != null) s.temperatureC = Number(b.temperatureC);
    if (b.durationHours != null) s.durationHours = Number(b.durationHours);

    const input = parseInput(s);
    const signature = inputSignature(element.id, input);
    const current = s.results.find(r => r.id === s.currentResultId);

    let result: ReturnType<typeof buildResult>;
    let reused = false;
    if (current && !current.superseded && current.inputSignature === signature) {
      // 同一构件、同一输入重复模拟：复用既有结果，不重复建任务
      result = current;
      reused = true;
    } else {
      if (current && !current.superseded) current.superseded = true;
      result = buildResult(element, input);
      s.results.push(result);
      s.currentResultId = result.id;
      s.status = 'simulated';
      log('load-scenario.simulate', s.id, { elementId: element.id, resultId: result.id, signature });
    }

    let inspection: Inspection | null = null;
    let inspectionCreated = false;
    if (result.risks.length) {
      const ensured = ensureInspectionFor(s, result);
      inspection = ensured.inspection;
      inspectionCreated = ensured.created;
    }

    return {
      ...s,
      result,
      reusedResult: reused,
      inspection: inspection ? { id: inspection.id, status: inspection.status, priority: inspection.priority, created: inspectionCreated } : null,
    };
  });
}
