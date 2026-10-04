import Fastify from 'fastify';
import { registerStructureRoutes } from './routes/structure.js';
import { registerReadingRoutes } from './routes/readings.js';
import { registerAssessmentRoutes } from './routes/assessment.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerScenarioRoutes } from './routes/scenarios.js';
import { registerInspectionRoutes } from './routes/inspections.js';

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? true });
  app.get('/health', async () => ({ ok: true, service: 'structural-health-fatigue-assessment', time: new Date().toISOString() }));
  await registerStructureRoutes(app);
  await registerReadingRoutes(app);
  await registerAssessmentRoutes(app);
  await registerHealthRoutes(app);
  await registerScenarioRoutes(app);
  await registerInspectionRoutes(app);
  return app;
}
