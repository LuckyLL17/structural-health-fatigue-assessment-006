export type Reading = { sensorId: string; timeMs: number; value: number; unit: string; quality: 'good' | 'suspect' | 'bad' };
export type Sensor = { id: string; name: string; type: 'strain' | 'acceleration' | 'displacement' | 'tilt' | 'temperature'; elementId: string; coordinate: { x: number; y: number; z: number }; unit: string; limits: { warning: number; critical: number }; status: 'online' | 'degraded' | 'offline' };

export type ElementType = 'girder' | 'pier';

export type Element = {
  id: string;
  structureId: string;
  type: ElementType;
  material: 'weathering-steel' | 'reinforced-concrete' | string;
  lengthM: number;
  section: string;
  allowableStressMpa: number;
  fatigueDetail: string;
  displacementLimitMm: number;
};

export type ScenarioInput = {
  vehicleLoadKn: number;
  windSpeedMs: number;
  temperatureC: number;
  durationHours: number;
};

export type ScenarioStatus = 'draft' | 'simulated';

export type RiskCode = 'stress' | 'displacement' | 'fatigue';
export type Severity = 'warning' | 'critical';

export type RiskFinding = {
  code: RiskCode;
  severity: Severity;
  ratio: number;
  message: string;
};

export type FatigueSummary = {
  rainflow: { cycles: number; rangeMean: number; maxRange: number };
  equivalentStressMpa: number;
  damage: number;
  remainingLifeYears: number;
  fatigueLimitMpa: number;
  utilization: number;
};

export type SimulationResult = {
  id: string;
  scenarioId: string;
  elementId: string;
  fingerprint: string;
  inputs: ScenarioInput;
  peakStressMpa: number;
  stressRatio: number;
  displacementMm: number;
  displacementLimitMm: number;
  displacementRatio: number;
  comfort: { accelerationG: number };
  fatigue: FatigueSummary;
  risks: RiskFinding[];
  status: 'normal' | 'warning' | 'critical';
  simulatedAt: string;
};

export type LoadScenario = {
  id: string;
  name: string;
  elementId: string;
  vehicleLoadKn: number;
  windSpeedMs: number;
  temperatureC: number;
  durationHours: number;
  status: ScenarioStatus;
  createdAt: string;
  updatedAt: string;
  currentResultId: string | null;
};

export type InspectionSource = 'manual' | 'risk-rule';

export type Inspection = {
  id: string;
  elementId: string;
  reason: string;
  priority: 'low' | 'medium' | 'high';
  status: 'planned' | 'closed';
  requestedAt: string;
  requiredEvidence: string[];
  evidence?: any[];
  closedAt?: string;
  source: InspectionSource;
  riskCode?: RiskCode;
  scenarioId?: string;
  resultFingerprint?: string;
  resultId?: string;
  closedBy?: 'evidence' | 'new-result';
};
