import type { Element, FatigueSummary, RiskCode, RiskFinding, ScenarioInput, Severity } from '../domain/types.js';
import { damageFor } from './fatigue.js';

/**
 * 荷载场景仿真：所有结果均取自目标构件自身属性
 * （截面几何、材料弹模、长度、容许应力、疲劳细节等级），
 * 不再固定使用第一个构件。系数为面向本服务标定的工程启发式值，
 * 以 G1/P2 的原始标定为基准，构件属性变化通过几何/材料比值传导。
 */

type SectionProps = { areaM2: number; inertiaM4: number; sectionModulusM3: number };

function parseSection(section: string): SectionProps {
  const box = section.match(/^box-([\d.]+)x([\d.]+)$/i);
  if (box) {
    const b = Number(box[1]);
    const h = Number(box[2]);
    const t = Math.max(0.012, Math.min(b, h) * 0.04);
    const bi = b - 2 * t;
    const hi = h - 2 * t;
    const inertiaM4 = (b * h ** 3 - bi * hi ** 3) / 12;
    const areaM2 = b * h - bi * hi;
    return { areaM2, inertiaM4, sectionModulusM3: inertiaM4 / (h / 2) };
  }
  const rect = section.match(/^([\d.]+)x([\d.]+)$/);
  if (rect) {
    const b = Number(rect[1]);
    const h = Number(rect[2]);
    const inertiaM4 = (b * h ** 3) / 12;
    return { areaM2: b * h, inertiaM4, sectionModulusM3: (b * h ** 2) / 6 };
  }
  return { areaM2: 1, inertiaM4: 1, sectionModulusM3: 1 };
}

const MATERIALS: Record<string, { elasticModulusMpa: number; thermalAlphaPerK: number; temperatureStressFactor: number }> = {
  'weathering-steel': { elasticModulusMpa: 206_000, thermalAlphaPerK: 12e-6, temperatureStressFactor: 1 },
  'reinforced-concrete': { elasticModulusMpa: 32_500, thermalAlphaPerK: 10e-6, temperatureStressFactor: 0.13 },
};

// 各构件类型的参考构件（用于把标定系数按几何/刚度比值传导到同类其他构件）
const TYPE_CONFIG = {
  girder: {
    refLengthM: 70,
    refSectionModulusM3: 0.823,
    refFlexuralStiffness: 206_000 * 0.988,
    vehicleStressCoeff: 0.41,
    windStressCoeff: 0.75,
    vehicleDisplacementCoeff: 0.055,
    windDisplacementCoeff: 0.012,
  },
  pier: {
    refLengthM: 28,
    refSectionModulusM3: 3.659,
    refFlexuralStiffness: 32_500 * 3.659,
    vehicleStressCoeff: 0.097,
    windStressCoeff: 0.15,
    vehicleDisplacementCoeff: 0.144,
    windDisplacementCoeff: 0.045,
  },
} as const;

function round(n: number, digits = 3): number {
  return Number(n.toFixed(digits));
}

/** 疲劳细节等级（MPa）：FAT-xx 直接解析，混凝土细节按经验映射 */
export function fatigueLimitFor(element: Element): number {
  const fat = /FAT-(\d+)/i.exec(element.fatigueDetail);
  if (fat) return Number(fat[1]);
  if (element.fatigueDetail.startsWith('RC')) return 25;
  return Math.round(element.allowableStressMpa * 0.34);
}

function finding(code: RiskCode, severity: Severity, ratio: number, message: string): RiskFinding {
  return { code, severity, ratio: round(ratio, 3), message };
}

export type SimulationOutput = {
  peakStressMpa: number;
  stressRatio: number;
  displacementMm: number;
  displacementLimitMm: number;
  displacementRatio: number;
  comfort: { accelerationG: number };
  fatigue: FatigueSummary;
  risks: RiskFinding[];
  status: 'normal' | 'warning' | 'critical';
};

export function simulateLoad(element: Element, input: ScenarioInput): SimulationOutput {
  const cfg = TYPE_CONFIG[element.type] ?? TYPE_CONFIG.girder;
  const sec = parseSection(element.section);
  const mat = MATERIALS[element.material] ?? MATERIALS['weathering-steel'];
  const lengthScale = cfg.refLengthM / element.lengthM;
  const modulusScale = cfg.refSectionModulusM3 / sec.sectionModulusM3;
  const stiffness = mat.elasticModulusMpa * sec.inertiaM4;
  const stiffnessScale = cfg.refFlexuralStiffness / stiffness;
  const deltaT = Math.abs(input.temperatureC - 20);

  // ---- 应力（峰值，MPa）：车辆 + 风 + 温差，均按构件几何/材料折算 ----
  const vehicleStress = input.vehicleLoadKn * cfg.vehicleStressCoeff * lengthScale * modulusScale;
  const windStress = input.windSpeedMs * cfg.windStressCoeff * lengthScale * modulusScale;
  const temperatureStress = deltaT * 0.08 * mat.temperatureStressFactor;
  const peakStressMpa = round(vehicleStress + windStress + temperatureStress, 2);
  const stressRatio = peakStressMpa / element.allowableStressMpa;

  // ---- 位移（mm）：车辆挠度 + 风侧向位移 + 温度轴向变形，按抗弯刚度折算 ----
  const vehicleDisplacement = input.vehicleLoadKn * cfg.vehicleDisplacementCoeff * stiffnessScale;
  const windDisplacement = input.windSpeedMs * cfg.windDisplacementCoeff * stiffnessScale;
  const thermalDisplacement = deltaT * element.lengthM * mat.thermalAlphaPerK * 1000;
  const displacementMm = round(vehicleDisplacement + windDisplacement + thermalDisplacement, 3);
  const displacementRatio = displacementMm / element.displacementLimitMm;

  // ---- 疲劳：应力历程随构件实际应力水平生成，损伤按构件容许应力计算 ----
  const series = [0, round((vehicleStress + windStress) * 0.45, 2), round(peakStressMpa, 2), round(vehicleStress * 0.4, 2), 0];
  const rawDamage = damageFor(element, series);
  const damage = Number((rawDamage.damage * Math.max(1, input.durationHours)).toFixed(8));
  const fatigueLimitMpa = fatigueLimitFor(element);
  const utilization = rawDamage.equivalentStressMpa / fatigueLimitMpa;
  const fatigue: FatigueSummary = {
    rainflow: rawDamage.rainflow,
    equivalentStressMpa: rawDamage.equivalentStressMpa,
    damage,
    remainingLifeYears: Number(Math.max(0, (1 - damage) * 100).toFixed(2)),
    fatigueLimitMpa,
    utilization: round(utilization, 3),
  };

  // ---- 风险规则 ----
  const risks: RiskFinding[] = [];
  if (stressRatio >= 1) risks.push(finding('stress', 'critical', stressRatio, `峰值应力 ${peakStressMpa}MPa 超过容许应力 ${element.allowableStressMpa}MPa`));
  else if (stressRatio >= 0.75) risks.push(finding('stress', 'warning', stressRatio, `峰值应力 ${peakStressMpa}MPa 接近容许应力 ${element.allowableStressMpa}MPa`));

  if (displacementRatio >= 1) risks.push(finding('displacement', 'critical', displacementRatio, `位移 ${displacementMm}mm 超过限值 ${element.displacementLimitMm}mm`));
  else if (displacementRatio >= 0.7) risks.push(finding('displacement', 'warning', displacementRatio, `位移 ${displacementMm}mm 接近限值 ${element.displacementLimitMm}mm`));

  if (utilization >= 1) risks.push(finding('fatigue', 'critical', utilization, `等效应力幅 ${fatigue.equivalentStressMpa}MPa 超过疲劳细节 ${element.fatigueDetail} 限值 ${fatigueLimitMpa}MPa`));
  else if (utilization >= 0.75) risks.push(finding('fatigue', 'warning', utilization, `等效应力幅 ${fatigue.equivalentStressMpa}MPa 接近疲劳细节 ${element.fatigueDetail} 限值 ${fatigueLimitMpa}MPa`));

  const status: SimulationOutput['status'] = risks.some(r => r.severity === 'critical')
    ? 'critical'
    : risks.some(r => r.severity === 'warning')
      ? 'warning'
      : 'normal';

  return {
    peakStressMpa,
    stressRatio: round(stressRatio, 3),
    displacementMm,
    displacementLimitMm: element.displacementLimitMm,
    displacementRatio: round(displacementRatio, 3),
    comfort: { accelerationG: round(peakStressMpa / 2000, 3) },
    fatigue,
    risks,
    status,
  };
}
