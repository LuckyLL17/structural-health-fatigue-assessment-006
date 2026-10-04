import type { Element } from '../domain/types.js';

/**
 * 简化雨流计数：用相邻样本的差值近似应力循环幅。
 */
export function rainflowApprox(values: number[]) {
  const ranges: number[] = [];
  for (let i = 1; i < values.length; i++) ranges.push(Math.abs(values[i] - values[i - 1]));
  return {
    cycles: ranges.length,
    rangeMean: ranges.length ? ranges.reduce((a, b) => a + b, 0) / ranges.length : 0,
    maxRange: Math.max(0, ...ranges),
  };
}

/**
 * 疲劳构造细节曲线：FAT-xx 按 IIW 约定取 xx MPa @2e6 次；
 * 混凝土钢筋细节按 RC-C 折算为 110 MPa @2e6 次；
 * 未登记的细节回退到构件许用应力，保持旧行为。
 */
const fatigueDetailCurves: Record<string, number> = {
  'FAT-71': 71,
  'FAT-80': 80,
  'FAT-90': 90,
  'FAT-100': 100,
  'FAT-112': 112,
  'FAT-125': 125,
  'RC-C': 110,
};

function detailStressMpa(element: Element) {
  return fatigueDetailCurves[element.fatigueDetail] ?? element.allowableStressMpa;
}

/**
 * Miner 线性累积损伤估算。
 * @param blocks 该应力序列代表的荷载循环块数（仿真按持续小时折算）。
 */
export function damageFor(element: Element, series: number[], blocks = 1) {
  const rainflow = rainflowApprox(series);
  const detailStress = detailStressMpa(element);
  const equivalent = Math.max(.001, rainflow.rangeMean / detailStress);
  // 每个采样间隔近似一个循环，按 2e6 次参考寿命、m=3 的 S-N 斜率折算。
  const damage = blocks * rainflow.cycles * Math.pow(equivalent, 3) / 2e6;
  return {
    rainflow,
    equivalentStressMpa: Number(rainflow.rangeMean.toFixed(3)),
    damage: Number(damage.toFixed(8)),
    remainingLifeYears: Number(Math.max(0, (1 - damage) * 100).toFixed(2)),
  };
}
