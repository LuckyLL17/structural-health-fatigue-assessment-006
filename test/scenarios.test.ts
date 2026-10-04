import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { alerts, audits, fatigueRuns, inspections, loadScenarios, modalRuns, readings, simulationResults } from '../src/domain/state.js';

// 进程内状态在每个用例前重置（构件/传感器等主数据保留）
function resetState() {
  alerts.length = 0;
  audits.length = 0;
  fatigueRuns.length = 0;
  inspections.length = 0;
  loadScenarios.length = 0;
  modalRuns.length = 0;
  readings.length = 0;
  simulationResults.length = 0;
}

let app: FastifyInstance;

before(async () => { app = await buildApp({ logger: false }); });
after(async () => { await app.close(); });
beforeEach(() => { resetState(); });

const draft = (body: any) => app.inject({ method: 'POST', url: '/api/load-scenarios', payload: body });
const sim = (id: string) => app.inject({ method: 'POST', url: `/api/load-scenarios/${id}/simulate` });
const patch = (id: string, body: any) => app.inject({ method: 'PATCH', url: `/api/load-scenarios/${id}`, payload: body });
const getScenario = (id: string) => app.inject({ method: 'GET', url: `/api/load-scenarios/${id}` });
const closeInspection = (id: string, body: any) => app.inject({ method: 'POST', url: `/api/inspections/${id}/close`, payload: body });

describe('荷载场景关联构件与仿真', () => {
  it('创建草稿必须指定目标构件，且构件必须存在', async () => {
    const noElement = await draft({ name: '未关联构件', vehicleLoadKn: 100 });
    assert.equal(noElement.statusCode, 400);
    assert.match(noElement.json().error, /elementId/);

    const badElement = await draft({ name: '坏构件', elementId: 'no-such', vehicleLoadKn: 100 });
    assert.equal(badElement.statusCode, 404);

    const ok = await draft({ name: 'G1 常规车流', elementId: 'girder-G1', vehicleLoadKn: 200 });
    assert.equal(ok.statusCode, 200);
    const s = ok.json();
    assert.equal(s.status, 'draft');
    assert.equal(s.elementId, 'girder-G1');
    assert.equal(s.currentResultId, null);
  });

  it('同一输入作用于不同构件，按各自属性给出不同应力/位移/疲劳与风险结果', async () => {
    const g = (await draft({ name: 'G1', elementId: 'girder-G1', vehicleLoadKn: 420 })).json();
    const p = (await draft({ name: 'P2', elementId: 'pier-P2', vehicleLoadKn: 420 })).json();

    const gr = (await sim(g.id)).json();
    const pr = (await sim(p.id)).json();

    // 420kN：钢箱梁疲劳超限但应力/位移尚可；混凝土墩应力与位移都超限
    assert.equal(gr.statusCode ?? 200, 200);
    assert.equal(gr.currentResult.elementId, 'girder-G1');
    assert.equal(gr.currentResult.peakStressMpa, 172.12);
    assert.equal(gr.currentResult.displacementLimitMm, 140);
    assert.deepEqual(gr.currentResult.risks.map((x: any) => x.code), ['fatigue']);

    assert.equal(pr.currentResult.elementId, 'pier-P2');
    assert.notEqual(pr.currentResult.peakStressMpa, gr.currentResult.peakStressMpa);
    assert.equal(pr.currentResult.displacementLimitMm, 40);
    assert.deepEqual(pr.currentResult.risks.map((x: any) => x.code), ['stress', 'displacement', 'fatigue']);
    assert.equal(pr.currentResult.status, 'critical');
  });

  it('达到风险规则时按风险代码创建检修任务，结果可直接交付检查人员', async () => {
    const s = (await draft({ name: 'P2 重车', elementId: 'pier-P2', vehicleLoadKn: 420 })).json();
    const r = (await sim(s.id)).json();

    const created = r.inspectionSync.filter((x: any) => x.action === 'created');
    assert.equal(created.length, 3);
    const stressTask = created.find((x: any) => x.riskCode === 'stress');
    assert.equal(stressTask.severity, 'critical');

    const list = (await app.inject({ method: 'GET', url: '/api/inspections' })).json().inspections;
    const task = list.find((x: any) => x.riskCode === 'stress');
    assert.equal(task.elementId, 'pier-P2');
    assert.equal(task.source, 'risk-rule');
    assert.equal(task.priority, 'high');
    assert.equal(task.status, 'planned');
    assert.equal(task.scenario.elementId, 'pier-P2');
    assert.equal(task.scenario.linkedResultStale, false);
    assert.match(task.reason, /stress/);
    assert.ok(task.requiredEvidence.includes('measurement'));
  });
});

describe('重复模拟幂等', () => {
  it('同一输入重复模拟不重复建任务，仅复用已有未关闭任务', async () => {
    const s = (await draft({ name: 'G1 疲劳', elementId: 'girder-G1', vehicleLoadKn: 420 })).json();

    const first = (await sim(s.id)).json();
    const firstIds = first.inspectionSync.map((x: any) => x.inspectionId);
    assert.equal(first.inspectionSync.filter((x: any) => x.action === 'created').length, 1);

    const second = (await sim(s.id)).json();
    assert.equal(second.inspectionSync[0].action, 'existing');
    assert.deepEqual(second.inspectionSync.map((x: any) => x.inspectionId), firstIds);
    assert.equal(second.currentResult.fingerprint, first.currentResult.fingerprint);

    const list = (await app.inject({ method: 'GET', url: '/api/inspections' })).json().inspections;
    assert.equal(list.length, 1);
  });
});

describe('过期结果不能关闭任务', () => {
  it('输入变化后旧结果标记 stale，拒绝关闭；重新模拟的新结果可以关闭', async () => {
    const s = (await draft({ name: 'G1 寿命', elementId: 'girder-G1', vehicleLoadKn: 420 })).json();
    const risky = (await sim(s.id)).json();
    const taskId = risky.inspectionSync[0].inspectionId;
    const oldResultId = risky.currentResultId;

    // 改输入（降到安全工况）后：场景回草稿，旧结果过期
    const edited = (await patch(s.id, { vehicleLoadKn: 200 })).json();
    assert.equal(edited.status, 'draft');
    assert.equal(edited.stale, true);

    const staleClose = await closeInspection(taskId, { closeWithResultId: oldResultId });
    assert.equal(staleClose.statusCode, 409);
    assert.match(staleClose.json().error, /stale result/);

    // 旧结果已不是当前结果
    assert.equal((await getScenario(s.id)).json().currentResultId, oldResultId);

    // 重新模拟得到无风险新结果，才能用新结果关闭
    const safe = (await sim(s.id)).json();
    assert.deepEqual(safe.currentResult.risks, []);
    assert.equal(safe.currentResultId === oldResultId, false);

    const closed = await closeInspection(taskId, { closeWithResultId: safe.currentResultId });
    assert.equal(closed.statusCode, 200);
    assert.equal(closed.json().status, 'closed');
    assert.equal(closed.json().closedBy, 'new-result');
  });

  it('目标构件变化后旧结果同样过期，且仍有风险的新结果不能关闭任务', async () => {
    const s = (await draft({ name: '420kN', elementId: 'girder-G1', vehicleLoadKn: 420 })).json();
    const risky = (await sim(s.id)).json();
    const taskId = risky.inspectionSync[0].inspectionId;
    const oldResultId = risky.currentResultId;

    await patch(s.id, { elementId: 'pier-P2' });
    const staleClose = await closeInspection(taskId, { closeWithResultId: oldResultId });
    assert.equal(staleClose.statusCode, 409);
    assert.match(staleClose.json().error, /stale result/);

    // 换成 P2 后 420kN 仍然风险，新结果也不能关闭 G1 的旧任务（构件不一致）
    const re = (await sim(s.id)).json();
    const wrongElement = await closeInspection(taskId, { closeWithResultId: re.currentResultId });
    assert.equal(wrongElement.statusCode, 409);
  });
});

describe('证据关闭与证据不足', () => {
  it('证据种类不足返回 409，证据齐备后关闭', async () => {
    const s = (await draft({ name: 'P2 重车', elementId: 'pier-P2', vehicleLoadKn: 420 })).json();
    const r = (await sim(s.id)).json();
    const taskId = r.inspectionSync.find((x: any) => x.riskCode === 'stress').inspectionId;

    const incomplete = await closeInspection(taskId, { evidence: ['photo', 'measurement'] });
    assert.equal(incomplete.statusCode, 409);
    assert.match(incomplete.json().error, /evidence incomplete/);
    assert.deepEqual(incomplete.json().required, ['photo', 'measurement', 'engineer-note']);

    const ok = await closeInspection(taskId, { evidence: ['photo', 'measurement', 'engineer-note'] });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().closedBy, 'evidence');
  });
});

describe('直接检修流程保留', () => {
  it('不经过模拟可直接建任务，且只能用证据关闭、不能用结果关闭', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/inspections',
      payload: { elementId: 'pier-P2', reason: '日常巡检发现表面裂缝', priority: 'high' },
    });
    assert.equal(created.statusCode, 200);
    const task = created.json();
    assert.equal(task.source, 'manual');
    assert.equal(task.scenario, null);

    const byResult = await closeInspection(task.id, { closeWithResultId: 'anything' });
    assert.equal(byResult.statusCode, 409);
    assert.match(byResult.json().error, /证据/);

    const ok = await closeInspection(task.id, { evidence: ['photo', 'measurement', 'engineer-note'] });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().status, 'closed');
  });
});

describe('风险消除闭环', () => {
  it('风险任务从建单到新结果关闭后，再次模拟风险输入会产生新任务', async () => {
    const s = (await draft({ name: 'G1', elementId: 'girder-G1', vehicleLoadKn: 420 })).json();
    const risky = (await sim(s.id)).json();
    assert.equal(risky.inspectionSync[0].action, 'created');

    await patch(s.id, { vehicleLoadKn: 100 });
    const safe = (await sim(s.id)).json();
    assert.equal(safe.currentResult.status, 'normal');
    const closed = await closeInspection(risky.inspectionSync[0].inspectionId, { closeWithResultId: safe.currentResultId });
    assert.equal(closed.statusCode, 200);

    // 荷载回升，风险重现：旧任务已关闭，新模拟按新结果建一条新任务
    await patch(s.id, { vehicleLoadKn: 420 });
    const riskyAgain = (await sim(s.id)).json();
    assert.equal(riskyAgain.inspectionSync[0].action, 'created');
    assert.notEqual(riskyAgain.inspectionSync[0].inspectionId, risky.inspectionSync[0].inspectionId);
  });
});
