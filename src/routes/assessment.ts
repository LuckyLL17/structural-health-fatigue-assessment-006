import { newId } from '../core/id.js';
import type { FastifyInstance } from 'fastify';
import { elements, fatigueRuns, log, modalRuns, now } from '../domain/state.js';
import { damageFor } from '../services/fatigue.js';

export async function registerAssessmentRoutes(app: FastifyInstance) {
  app.post('/api/modal-analysis', async (req: any, res: any) => {
    const b = req.body as any;
    if (!b.structureId || !Array.isArray(b.accelerationSamples)) {
      return res.code(400).send({ error: 'structureId 和 accelerationSamples 必填' });
    }
    const samples = b.accelerationSamples.map(Number);
    const peak = Math.max(...samples.map(Math.abs), 0);
    const dominantHz = Number((
      b.sampleRateHz
        ? b.sampleRateHz / Math.max(1, samples.length) * Math.max(1, samples.findIndex((x: number) => Math.abs(x) === peak))
        : 1.42
    ).toFixed(3));
    const baseline = Number(b.baselineHz || 1.38);
    const run = {
      id: newId(),
      structureId: b.structureId,
      createdAt: now(),
      sampleCount: samples.length,
      dominantFrequencyHz: dominantHz,
      baselineFrequencyHz: baseline,
      frequencyShiftPercent: Number(((dominantHz - baseline) / baseline * 100).toFixed(2)),
      dampingRatio: Number((b.dampingRatio || .025).toFixed(4)),
      modeShape: b.modeShape || [{ x: 0, amplitude: 0 }, { x: 210, amplitude: peak }, { x: 420, amplitude: 0 }],
      status: Math.abs(dominantHz - baseline) / baseline > .08 ? 'investigate' : 'normal',
    };
    modalRuns.push(run);
    log('modal.analysis', run.id, run);
    return run;
  });

  app.post('/api/fatigue/assessment', async (req: any, res: any) => {
    const b = req.body as any;
    if (!b.elementId || !Array.isArray(b.stressSeriesMpa)) {
      return res.code(400).send({ error: 'elementId 和 stressSeriesMpa 必填' });
    }
    const element = elements.find(x => x.id === b.elementId);
    if (!element) return res.code(404).send({ error: 'element not found' });
    const result = damageFor(element, b.stressSeriesMpa.map(Number));
    const run = {
      id: newId(),
      elementId: element.id,
      createdAt: now(),
      historyYears: Number(b.historyYears || 1),
      damage: result.damage,
      remainingLifeYears: result.remainingLifeYears,
      rainflow: result.rainflow,
      equivalentStressMpa: result.equivalentStressMpa,
      confidence: Number(b.confidence || .72),
      status: result.damage > .35 ? 'critical' : result.damage > .15 ? 'warning' : 'normal',
    };
    fatigueRuns.push(run);
    log('fatigue.assess', run.id, run);
    return run;
  });
}
