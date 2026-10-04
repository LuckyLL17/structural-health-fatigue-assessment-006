/* 端到端流程验证（需先启动服务：npm run dev 或 npm start） */
const BASE = process.env.BASE || 'http://127.0.0.1:6312';

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}`, extra ?? '');
  }
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function main() {
  // ---------- 1. 草稿流程：不关联构件可建草稿，但未关联构件不能模拟 ----------
  console.log('1. 草稿流程 / 目标构件门禁');
  const draft = await call('POST', '/api/load-scenarios', { name: '草稿-无构件', vehicleLoadKn: 500 });
  check('草稿可无构件创建', draft.status === 200 && draft.body.status === 'draft' && draft.body.elementId === null);
  const noEl = await call('POST', `/api/load-scenarios/${draft.body.id}/simulate`, {});
  check('未关联构件模拟被拒', noEl.status === 400);
  const badEl = await call('POST', '/api/load-scenarios', { name: '坏构件', vehicleLoadKn: 1, elementId: 'nope' });
  check('关联不存在构件返回404', badEl.status === 404);

  // ---------- 2. 不同构件：主梁模拟（安全结果，不建任务） ----------
  console.log('2. 主梁构件安全模拟');
  const g = await call('POST', '/api/load-scenarios', { name: 'G1 常规车流', elementId: 'girder-G1', vehicleLoadKn: 1200, windSpeedMs: 10, temperatureC: 25, durationHours: 1 });
  const gSafe = await call('POST', `/api/load-scenarios/${g.body.id}/simulate`, {});
  check('按 G1 属性计算应力/位移/疲劳', gSafe.status === 200
    && gSafe.body.result.elementId === 'girder-G1'
    && gSafe.body.result.peakStressMpa > 0
    && gSafe.body.result.displacementMm > 0
    && gSafe.body.result.fatigue.rainflow.cycles === 4
    && gSafe.body.result.status === 'safe', gSafe.body.result);
  check('安全结果不建检修任务', gSafe.body.inspection === null);

  // ---------- 3. 风险结果：重载触发应力/位移风险，自动建任务 ----------
  console.log('3. 主梁重载风险 -> 自动检修任务');
  const r = await call('POST', '/api/load-scenarios', { name: 'G1 重载', elementId: 'girder-G1', vehicleLoadKn: 12000, windSpeedMs: 20, temperatureC: 20, durationHours: 2 });
  const rRisk = await call('POST', `/api/load-scenarios/${r.body.id}/simulate`, {});
  check('风险结果命中规则', rRisk.body.result.risks.length >= 1
    && rRisk.body.result.risks.some((x: any) => x.code === 'stress-overlimit' || x.code === 'displacement-overlimit'), rRisk.body.result.risks);
  check('自动创建风险检修任务', rRisk.body.inspection && rRisk.body.inspection.created === true && rRisk.body.inspection.status === 'planned');
  const taskId = rRisk.body.inspection.id;
  const taskDetail = await call('GET', '/api/inspections/' + 'x'); // 仅触发404路径
  check('不存在任务404', taskDetail.status === 404);

  // ---------- 4. 重复模拟幂等：同一输入不重复建任务 ----------
  console.log('4. 同一输入重复模拟幂等');
  const rAgain = await call('POST', `/api/load-scenarios/${r.body.id}/simulate`, {});
  check('复用既有结果', rAgain.body.reusedResult === true && rAgain.body.result.id === rRisk.body.result.id);
  check('不重复建任务', rAgain.body.inspection && rAgain.body.inspection.created === false && rAgain.body.inspection.id === taskId);
  const list = await call('GET', `/api/inspections?scenarioId=${r.body.id}&status=planned`);
  check('该场景风险输入只有一条未关闭任务', list.body.inspections.length === 1, list.body.inspections.map((x: any) => x.id));

  // ---------- 5. 证据不足不能关闭 ----------
  console.log('5. 证据不足关闭被拒');
  const noEvidence = await call('POST', `/api/inspections/${taskId}/close`, {});
  check('无证据 409', noEvidence.status === 409 && noEvidence.body.code === 'inspection-evidence-insufficient');
  const partial = await call('POST', `/api/inspections/${taskId}/close`, { evidence: ['photo', 'measurement'] });
  check('证据不全 409 且回传缺失项', partial.status === 409 && partial.body.code === 'inspection-evidence-insufficient'
    && Array.isArray(partial.body.required) && partial.body.required.includes('engineer-note'));
  const noResult = await call('POST', `/api/inspections/${taskId}/close`, { evidence: ['photo', 'measurement', 'engineer-note'] });
  check('证据齐但无新结果 409', noResult.status === 409 && noResult.body.code === 'close-result-required');

  // ---------- 6. 旧结果不得关闭任务 ----------
  console.log('6. 旧结果/创建结果不能关闭');
  const oldClose = await call('POST', `/api/inspections/${taskId}/close`, { evidence: ['photo', 'measurement', 'engineer-note'], resultId: rRisk.body.result.id });
  check('用创建任务的旧结果关闭 409(result-stale)', oldClose.status === 409 && oldClose.body.code === 'result-stale');

  // ---------- 7. 输入变化后旧结果过期 ----------
  console.log('7. 输入变化 -> 旧结果作废、场景退回草稿');
  const patched = await call('PATCH', `/api/load-scenarios/${r.body.id}`, { vehicleLoadKn: 1200 });
  check('编辑后回到 draft', patched.body.status === 'draft' && patched.body.currentResultId === null);
  check('旧结果标记 superseded', patched.body.results.every((x: any) => x.superseded === true));
  const staleClose = await call('POST', `/api/inspections/${taskId}/close`, { evidence: ['photo', 'measurement', 'engineer-note'], resultId: rRisk.body.result.id });
  check('过期结果关闭 409(result-stale)', staleClose.status === 409 && staleClose.body.code === 'result-stale');

  // ---------- 8. 新结果关闭任务 ----------
  console.log('8. 新的安全结果 + 完整证据关闭任务');
  const safeSim = await call('POST', `/api/load-scenarios/${r.body.id}/simulate`, {});
  check('降载后新结果安全', safeSim.body.result.status === 'safe' && safeSim.body.result.superseded === false);
  check('安全结果不再新建任务', safeSim.body.inspection === null);
  const closed = await call('POST', `/api/inspections/${taskId}/close`, { evidence: ['photo', 'measurement', 'engineer-note'], resultId: safeSim.body.result.id });
  check('新结果+完整证据关闭成功', closed.status === 200 && closed.body.status === 'closed' && closed.body.closeResultId === safeSim.body.result.id);
  const closedAgain = await call('POST', `/api/inspections/${taskId}/close`, { evidence: ['photo', 'measurement', 'engineer-note'], resultId: safeSim.body.result.id });
  check('重复关闭 409', closedAgain.status === 409);
  // 任务已关闭后再次恢复风险输入：视为新的一轮，应允许创建新任务
  const riskAgain = await call('PATCH', `/api/load-scenarios/${r.body.id}`, { vehicleLoadKn: 12000 });
  await call('POST', `/api/load-scenarios/${r.body.id}/simulate`, {});
  const list2 = await call('GET', `/api/inspections?scenarioId=${r.body.id}&status=planned`);
  check('关闭后同输入再次风险 -> 新任务（旧任务已关闭）', list2.body.inspections.length === 1 && list2.body.inspections[0].id !== taskId);

  // ---------- 9. 更换目标构件：构件不匹配的结果不能关任务 ----------
  console.log('9. 目标构件切换与构件匹配校验');
  const p = await call('POST', '/api/load-scenarios', { name: 'P2 强风', elementId: 'pier-P2', vehicleLoadKn: 2000, windSpeedMs: 95, temperatureC: 20, durationHours: 1 });
  const pRisk = await call('POST', `/api/load-scenarios/${p.body.id}/simulate`, {});
  check('桥墩按自身属性出风险（强风侧移预警）', pRisk.body.result.elementId === 'pier-P2' && pRisk.body.result.risks.some((x: any) => x.code === 'displacement-overlimit'), pRisk.body.result.risks);
  const pTask = pRisk.body.inspection.id;
  // 换成主梁模拟出安全结果，再拿去关桥墩任务
  const switched = await call('PATCH', `/api/load-scenarios/${p.body.id}`, { elementId: 'girder-G1', windSpeedMs: 5, vehicleLoadKn: 500 });
  check('换构件后旧结果过期', switched.body.status === 'draft');
  const gSafe2 = await call('POST', `/api/load-scenarios/${p.body.id}/simulate`, {});
  check('结果构件跟随为 G1', gSafe2.body.result.elementId === 'girder-G1' && gSafe2.body.result.status === 'safe');
  const mismatch = await call('POST', `/api/inspections/${pTask}/close`, { evidence: ['photo', 'measurement', 'engineer-note'], resultId: gSafe2.body.result.id });
  check('构件不匹配结果不能关闭 409', mismatch.status === 409 && mismatch.body.code === 'result-element-mismatch');

  // ---------- 10. 直接检修流程保留 ----------
  console.log('10. 直接检修流程');
  const d = await call('POST', '/api/inspections', { elementId: 'pier-P2', reason: '巡检发现表面裂缝', priority: 'high' });
  check('直接检修任务创建', d.status === 200 && d.body.source === 'direct');
  const dBad = await call('POST', `/api/inspections/${d.body.id}/close`, { evidence: ['photo'] });
  check('直接检修同样检查证据充分性', dBad.status === 409 && dBad.body.code === 'inspection-evidence-insufficient');
  const dClose = await call('POST', `/api/inspections/${d.body.id}/close`, { evidence: ['photo', 'measurement', 'engineer-note'] });
  check('直接检修无需模拟结果即可关闭', dClose.status === 200 && dClose.body.status === 'closed');
  const dMiss = await call('POST', '/api/inspections', { elementId: 'pier-P2' });
  check('缺 reason 400', dMiss.status === 400);

  // ---------- 汇总 ----------
  const summary = await call('GET', '/api/health/summary');
  console.log('\nhealth summary:', JSON.stringify(summary.body));
  if (failures) {
    console.error(`\n${failures} 项检查失败`);
    process.exit(1);
  }
  console.log('\n全部检查通过 ✅');
}

main().catch(e => { console.error(e); process.exit(1); });
