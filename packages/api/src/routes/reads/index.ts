import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@minicoder/core';
import { registerProjectReadRoutes } from './projects.js';
import { registerPlanningReadRoutes } from './planning.js';
import { registerFeatureReadRoutes } from './features.js';
import { registerAgentReadRoutes } from './agents.js';
import { registerGovernanceReadRoutes } from './governance.js';
import { registerArtifactReadRoutes } from './artifacts.js';
import { registerWorkflowReadRoutes } from './workflow.js';
import { registerWhoamiRoute } from './whoami.js';
import { registerObservabilityReadRoutes } from './observability.js';

export function registerAllReadRoutes(app: FastifyInstance, db: DbClient): void {
  registerProjectReadRoutes(app, db);
  registerPlanningReadRoutes(app, db);
  registerFeatureReadRoutes(app, db);
  registerAgentReadRoutes(app, db);
  registerGovernanceReadRoutes(app, db);
  registerArtifactReadRoutes(app, db);
  registerWorkflowReadRoutes(app, db);
  registerWhoamiRoute(app);
  registerObservabilityReadRoutes(app, db);
}
