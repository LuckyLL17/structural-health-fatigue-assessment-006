import Fastify from 'fastify';
import { registerStructureRoutes } from './routes/structure.js';
import { registerReadingRoutes } from './routes/readings.js';
import { registerAssessmentRoutes } from './routes/assessment.js';
import { registerLoadScenarioRoutes } from './routes/load-scenarios.js';
import { registerInspectionRoutes } from './routes/inspections.js';
import { registerHealthRoutes } from './routes/health.js';

export async function buildApp() {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ ok: true, service: 'structural-health-fatigue-assessment', time: new Date().toISOString() }));

  await registerStructureRoutes(app);
  await registerReadingRoutes(app);
  await registerAssessmentRoutes(app);
  await registerLoadScenarioRoutes(app);
  await registerInspectionRoutes(app);
  await registerHealthRoutes(app);

  return app;
}
