export type Reading = { sensorId: string; timeMs: number; value: number; unit: string; quality: 'good' | 'suspect' | 'bad' };

export type Sensor = {
  id: string;
  name: string;
  type: 'strain' | 'acceleration' | 'displacement' | 'tilt' | 'temperature';
  elementId: string;
  coordinate: { x: number; y: number; z: number };
  unit: string;
  limits: { warning: number; critical: number };
  status: 'online' | 'degraded' | 'offline';
};

export type Element = {
  id: string;
  name: string;
  structureId: string;
  type: 'girder' | 'pier' | string;
  material: 'weathering-steel' | 'reinforced-concrete' | string;
  lengthM: number;
  section: string;
  allowableStressMpa: number;
  fatigueDetail: string;
};

export type ElementMaterialProps = {
  elasticModulusGpa: number;
  thermalExpansionPerC: number;
};

export type RiskLevel = 'critical' | 'warning';

export type RiskRuleHit = {
  code: 'stress-overlimit' | 'displacement-overlimit' | 'fatigue-damage';
  level: RiskLevel;
  observed: number;
  threshold: number;
  message: string;
};

export type ScenarioInput = {
  vehicleLoadKn: number;
  windSpeedMs: number;
  temperatureC: number;
  durationHours: number;
};

export type ScenarioResult = {
  id: string;
  simulatedAt: string;
  elementId: string;
  elementName?: string;
  input: ScenarioInput;
  /** 输入快照签名：同一构件同一输入重复模拟时签名不变，用于幂等建任务 */
  inputSignature: string;
  peakStressMpa: number;
  allowableStressMpa: number;
  stressUtilization: number;
  displacementMm: number;
  displacementLimitMm: number;
  displacementUtilization: number;
  comfort: { accelerationG: number };
  fatigue: {
    rainflow: { cycles: number; rangeMean: number; maxRange: number };
    equivalentStressMpa: number;
    damage: number;
    remainingLifeYears: number;
  };
  risks: RiskRuleHit[];
  status: 'risk' | 'safe';
  /** 被同场景的后续模拟取代后置为 true，过期结果不得再用于关闭检修任务 */
  superseded: boolean;
};

export type LoadScenario = {
  id: string;
  name: string;
  elementId: string | null;
  vehicleLoadKn: number;
  windSpeedMs: number;
  temperatureC: number;
  durationHours: number;
  status: 'draft' | 'simulated';
  createdAt: string;
  updatedAt: string;
  /** 当前生效结果；编辑输入或更换构件后旧结果留痕但标记 superseded */
  currentResultId: string | null;
  results: ScenarioResult[];
};

export type Inspection = {
  id: string;
  elementId: string;
  reason: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'planned' | 'closed';
  requestedAt: string;
  requiredEvidence: string[];
  /** direct = 直接检修流程；load-simulation = 风险规则自动创建 */
  source: 'direct' | 'load-simulation';
  scenarioId?: string;
  scenarioName?: string;
  /** 创建任务时所依据的输入签名，保证重复模拟不重复建任务 */
  inputSignature?: string;
  riskCodes?: string[];
  resultId?: string;
  closeResultId?: string;
  evidence?: string[];
  closedAt?: string;
};
