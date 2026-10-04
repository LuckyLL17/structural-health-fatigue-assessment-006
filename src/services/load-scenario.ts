import { createHash } from 'node:crypto';
import type {
  Element,
  ElementMaterialProps,
  RiskRuleHit,
  ScenarioInput,
  ScenarioResult,
} from '../domain/types.js';
import { damageFor } from './fatigue.js';
import { newId } from '../core/id.js';
import { now } from '../domain/state.js';

const materialProps: Record<string, ElementMaterialProps> = {
  'weathering-steel': { elasticModulusGpa: 206, thermalExpansionPerC: 1.2e-5 },
  'reinforced-concrete': { elasticModulusGpa: 32.5, thermalExpansionPerC: 1.0e-5 },
};

function propsOf(element: Element): ElementMaterialProps {
  return materialProps[element.material]
    ?? { elasticModulusGpa: 200, thermalExpansionPerC: 1.1e-5 };
}

type SectionProps = { iM4: number; sectionModulusM3: number };

/**
 * 解析截面尺寸（米），返回惯性矩与截面模量。
 * box-w x h 为薄壁箱形（壁厚 30mm），其余按矩形实心截面。
 */
function sectionOf(section: string): SectionProps & { widthM: number } {
  const m = section.match(/(?:box-)?([\d.]+)x([\d.]+)/);
  if (!m) return { iM4: 1, sectionModulusM3: 1, widthM: 1 };
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (section.startsWith('box-')) {
    const tw = 0.03;
    const wi = Math.max(0.01, w - 2 * tw);
    const hi = Math.max(0.01, h - 2 * tw);
    const iM4 = (w * h ** 3 - wi * hi ** 3) / 12;
    return { iM4, sectionModulusM3: iM4 / (h / 2), widthM: w };
  }
  const iM4 = w * h ** 3 / 12;
  return { iM4, sectionModulusM3: w * h ** 2 / 6, widthM: w };
}

/** 不同构件类型对车辆轴重的参与比例（其余车重由相邻跨/墩分担）。 */
const vehicleShareByType: Record<string, number> = {
  girder: 0.455,
  pier: 0.09,
};

/** 横向受风高度系数：等效迎风高度占构件长度的比例。 */
const windArmByType: Record<string, number> = {
  girder: 0.22,
  pier: 0.42,
};

/**
 * 按目标构件属性计算应力（MPa）与位移（mm）。
 * 弯矩 kN·m 除以截面模量 m³ 得到 kPa，再 /1000 换算为 MPa；
 * 位移统一用 kN、MPa（N/mm²）、m：kN·m³/(MPa·m⁴)=m，再 ×1000 换算为 mm。
 */
export function simulateOnElement(element: Element, input: ScenarioInput) {
  const { elasticModulusGpa, thermalExpansionPerC } = propsOf(element);
  const eMpa = elasticModulusGpa * 1000;
  const { iM4, sectionModulusM3, widthM } = sectionOf(element.section);
  const L = element.lengthM;

  const vehicleKn = input.vehicleLoadKn * (vehicleShareByType[element.type] ?? 0.3);
  const windPressureKpa = 0.0006 * input.windSpeedMs ** 2;
  const windForceKn = windPressureKpa * L * widthM;
  const windArmM = (windArmByType[element.type] ?? 0.3) * L;

  const stressVehicleMpa = vehicleKn * 0.25 * L / sectionModulusM3 / 1000;
  const stressWindMpa = windForceKn * windArmM / sectionModulusM3 / 1000;
  const stressTempMpa = eMpa * thermalExpansionPerC * (input.temperatureC - 20);
  const peakStressMpa = Number((stressVehicleMpa + stressWindMpa + Math.abs(stressTempMpa)).toFixed(3));

  // kN·m³ /(MPa·m⁴) 量纲即为 mm，无需额外换算
  const windKFactor = element.type === 'pier' ? 3 : 48;
  const displacementVehicleMm = element.type === 'pier'
    ? 0 // 车辆轴重沿墩柱轴向，不产生墩顶侧移
    : vehicleKn * L ** 3 / (48 * eMpa * iM4);
  const displacementWindMm = windForceKn * L ** 3 / (windKFactor * eMpa * iM4);
  const displacementMm = Number((displacementVehicleMm + displacementWindMm).toFixed(3));

  return { peakStressMpa, displacementMm };
}

export function inputSignature(elementId: string, input: ScenarioInput): string {
  const normalized = [
    elementId,
    input.vehicleLoadKn,
    input.windSpeedMs,
    input.temperatureC,
    input.durationHours,
  ].join('|');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * 风险规则：
 * - 应力利用率 >=1 严重、>=0.7 预警；
 * - 位移超过 L/300 严重、超过 L/500 预警；
 * - Miner 损伤 >0.35 严重、>0.15 预警。
 */
export function evaluateRisks(
  element: Element,
  input: ScenarioInput,
  mechanics: { peakStressMpa: number; displacementMm: number },
  fatigue: ReturnType<typeof damageFor>,
): RiskRuleHit[] {
  const risks: RiskRuleHit[] = [];

  const stressUtilization = Number((mechanics.peakStressMpa / element.allowableStressMpa).toFixed(3));
  if (stressUtilization >= 1) {
    risks.push({
      code: 'stress-overlimit', level: 'critical', observed: stressUtilization, threshold: 1,
      message: `峰值应力 ${mechanics.peakStressMpa}MPa 超过构件许用应力 ${element.allowableStressMpa}MPa`,
    });
  } else if (stressUtilization >= 0.7) {
    risks.push({
      code: 'stress-overlimit', level: 'warning', observed: stressUtilization, threshold: 0.7,
      message: `峰值应力 ${mechanics.peakStressMpa}MPa 达到许用应力 ${element.allowableStressMpa}MPa 的 70%`,
    });
  }

  const warningMm = element.lengthM * 1000 / 500;
  const criticalMm = element.lengthM * 1000 / 300;
  if (mechanics.displacementMm >= criticalMm) {
    risks.push({
      code: 'displacement-overlimit', level: 'critical',
      observed: mechanics.displacementMm, threshold: Number(criticalMm.toFixed(2)),
      message: `位移 ${mechanics.displacementMm}mm 超过限值 ${criticalMm.toFixed(1)}mm（L/300）`,
    });
  } else if (mechanics.displacementMm >= warningMm) {
    risks.push({
      code: 'displacement-overlimit', level: 'warning',
      observed: mechanics.displacementMm, threshold: Number(warningMm.toFixed(2)),
      message: `位移 ${mechanics.displacementMm}mm 超过预警值 ${warningMm.toFixed(1)}mm（L/500）`,
    });
  }

  if (fatigue.damage > 0.35) {
    risks.push({
      code: 'fatigue-damage', level: 'critical', observed: fatigue.damage, threshold: 0.35,
      message: `Miner 损伤 ${fatigue.damage} 超过 0.35，剩余寿命约 ${fatigue.remainingLifeYears} 年`,
    });
  } else if (fatigue.damage > 0.15) {
    risks.push({
      code: 'fatigue-damage', level: 'warning', observed: fatigue.damage, threshold: 0.15,
      message: `Miner 损伤 ${fatigue.damage} 超过 0.15，剩余寿命约 ${fatigue.remainingLifeYears} 年`,
    });
  }

  return risks;
}

export function buildResult(element: Element, input: ScenarioInput): ScenarioResult {
  const mechanics = simulateOnElement(element, input);
  const blocks = Math.max(1, Math.round(input.durationHours * 60));
  const stressSeries = [
    0,
    mechanics.peakStressMpa * 0.45,
    mechanics.peakStressMpa,
    mechanics.peakStressMpa * 0.4,
    0,
  ];
  const fatigue = damageFor(element, stressSeries, blocks);
  const risks = evaluateRisks(element, input, mechanics, fatigue);
  const warningMm = element.lengthM * 1000 / 500;

  return {
    id: newId(),
    simulatedAt: now(),
    elementId: element.id,
    elementName: element.name,
    input: { ...input },
    inputSignature: inputSignature(element.id, input),
    peakStressMpa: mechanics.peakStressMpa,
    allowableStressMpa: element.allowableStressMpa,
    stressUtilization: Number((mechanics.peakStressMpa / element.allowableStressMpa).toFixed(3)),
    displacementMm: mechanics.displacementMm,
    displacementLimitMm: Number(warningMm.toFixed(2)),
    displacementUtilization: Number((mechanics.displacementMm / warningMm).toFixed(3)),
    comfort: { accelerationG: Number((mechanics.peakStressMpa / 2000).toFixed(3)) },
    fatigue,
    risks,
    status: risks.length ? 'risk' : 'safe',
    superseded: false,
  };
}
