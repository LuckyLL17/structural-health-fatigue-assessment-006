import { newId } from '../core/id.js';
import { scenarioFingerprint } from '../core/fingerprint.js';
import type { FastifyInstance } from 'fastify';
import { elements, loadScenarios, log, now, simulationResults } from '../domain/state.js';
import type { LoadScenario, ScenarioInput } from '../domain/types.js';
import { simulateLoad } from '../services/load-simulation.js';
import { currentFingerprint, currentResult, scenarioInput, scenarioView, syncRiskInspections } from '../services/inspections.js';

const NUMERIC_FIELDS = ['vehicleLoadKn', 'windSpeedMs', 'temperatureC', 'durationHours'] as const;

function readInput(b: any): Partial<ScenarioInput> {
  const input: any = {};
  for (const f of NUMERIC_FIELDS) if (b[f] != null) input[f] = Number(b[f]);
  return input;
}

/** 模拟后修改输入或目标构件 => 回到草稿，旧结果保留但标记过期，不能再用于关闭任务 */
function touchScenario(s: LoadScenario) {
  const result = currentResult(s);
  if (result && result.fingerprint !== currentFingerprint(s)) s.status = 'draft';
  s.updatedAt = now();
}

export async function registerScenarioRoutes(app: FastifyInstance) {
  // 创建草稿：必须指定目标构件
  app.post('/api/load-scenarios', async (req: any, res: any) => {
    const b = req.body as any;
    if (!b.name || b.vehicleLoadKn == null) return res.code(400).send({ error: 'name 和 vehicleLoadKn 必填' });
    if (!b.elementId) return res.code(400).send({ error: 'elementId 必填：荷载场景必须关联目标构件' });
    const element = elements.find(x => x.id === b.elementId);
    if (!element) return res.code(404).send({ error: 'element not found' });
    const s: LoadScenario = {
      id: newId(),
      name: String(b.name),
      elementId: element.id,
      vehicleLoadKn: Number(b.vehicleLoadKn),
      windSpeedMs: Number(b.windSpeedMs || 0),
      temperatureC: Number(b.temperatureC || 20),
      durationHours: Number(b.durationHours || 1),
      status: 'draft',
      createdAt: now(),
      updatedAt: now(),
      currentResultId: null,
    };
    loadScenarios.push(s);
    log('scenario.create', s.id, { name: s.name, elementId: s.elementId });
    return scenarioView(s);
  });

  app.get('/api/load-scenarios', async () => ({ scenarios: loadScenarios.map(scenarioView) }));

  app.get('/api/load-scenarios/:id', async (req: any, res: any) => {
    const s = loadScenarios.find(x => x.id === (req.params as any).id);
    if (!s) return res.code(404).send({ error: 'scenario not found' });
    return scenarioView(s);
  });

  // 编辑草稿/已模拟场景：改输入或目标构件后旧结果立即过期
  app.patch('/api/load-scenarios/:id', async (req: any, res: any) => {
    const s = loadScenarios.find(x => x.id === (req.params as any).id);
    if (!s) return res.code(404).send({ error: 'scenario not found' });
    const b = req.body as any;
    if (b.elementId != null) {
      const element = elements.find(x => x.id === b.elementId);
      if (!element) return res.code(404).send({ error: 'element not found' });
      s.elementId = element.id;
    }
    if (b.name != null) s.name = String(b.name);
    Object.assign(s, readInput(b));
    touchScenario(s);
    log('scenario.update', s.id, { elementId: s.elementId, input: scenarioInput(s) });
    return scenarioView(s);
  });

  // 模拟：按关联构件属性计算应力/位移/疲劳，命中风险规则即建检修任务
  app.post('/api/load-scenarios/:id/simulate', async (req: any, res: any) => {
    const s = loadScenarios.find(x => x.id === (req.params as any).id);
    if (!s) return res.code(404).send({ error: 'scenario not found' });
    const element = elements.find(x => x.id === s.elementId);
    if (!element) return res.code(404).send({ error: 'target element not found' });

    const input = scenarioInput(s);
    const fp = scenarioFingerprint(element.id, input);
    const output = simulateLoad(element, input);
    const result = {
      id: newId(),
      scenarioId: s.id,
      elementId: element.id,
      fingerprint: fp,
      inputs: input,
      ...output,
      simulatedAt: now(),
    };
    simulationResults.push(result);
    s.currentResultId = result.id;
    s.status = 'simulated';
    s.updatedAt = now();

    const outcomes = syncRiskInspections(s, result);
    log('scenario.simulate', s.id, {
      resultId: result.id,
      elementId: element.id,
      fingerprint: fp,
      status: result.status,
      risks: result.risks.map((x: any) => x.code),
      created: outcomes.filter(x => x.action === 'created').length,
    });
    return {
      ...scenarioView(s),
      inspectionSync: outcomes.map(x => ({ riskCode: x.finding.code, severity: x.finding.severity, action: x.action, inspectionId: x.inspection.id })),
    };
  });
}
