import type { ScenarioInput } from '../domain/types.js';

/**
 * 场景输入 + 目标构件的归一化指纹。
 * 同一构件 + 同一组输入 => 同一指纹（重复模拟幂等）；
 * 输入任一字段或目标构件变化 => 指纹变化（旧结果立即过期）。
 */
export function scenarioFingerprint(elementId: string, input: ScenarioInput): string {
  const n = (v: number) => Number(v).toFixed(3);
  return [
    elementId,
    n(input.vehicleLoadKn),
    n(input.windSpeedMs),
    n(input.temperatureC),
    n(input.durationHours),
  ].join('|');
}
