export {
  resolveDatabaseConfig,
  sanitizeDatabaseUrl,
  type DatabaseConfig,
  type ResolveDatabaseConfigOptions,
} from "./config.js";

export {
  createDatabaseInstance,
  getDefaultDb,
  closeDefaultDb,
  type FactoryDb,
  type FactoryDatabaseInstance,
} from "./db.js";

export {
  projects,
  sites,
  deployments,
  runs,
  tasks,
  attempts,
  qualityResults,
  modelInvocations,
  type ProjectRecord,
  type InsertProject,
  type SiteRecord,
  type InsertSite,
  type DeploymentRecord,
  type InsertDeployment,
  type RunRecord,
  type InsertRun,
  type TaskRecord,
  type InsertTask,
  type AttemptRecord,
  type InsertAttempt,
  type QualityResultRecord,
  type InsertQualityResult,
  type ModelInvocationRecord,
  type InsertModelInvocation,
} from "./schema.js";

export {
  acquireControlPlaneLock,
  withControlPlaneLock,
  FACTORY_CONTROL_PLANE_LOCK_KEY,
  type ControlPlaneLockHandle,
} from "./lock.js";

export {
  recoverStaleExecutionState,
  type RecoveryReport,
} from "./recovery.js";

export {
  FactoryStore,
  computeIdempotencyKey,
  truncateBounded,
} from "./store.js";

export {
  migrateDb,
  type MigrateOptions,
} from "./migrate.js";

export {
  DatabaseLifecycleObserver,
  type ExecutorLifecycleObserver,
  type AttemptStartedEvent,
  type AttemptCompletedEvent,
  type QualityGateEvent,
  type ModelInvocationEvent,
} from "./lifecycle.js";

export {
  runPersistedSiteTask,
  type PersistedRunOptions,
} from "./driver.js";

export {
  reconstructTaskResultFromPersistence,
  resolveDurableTaskResult,
  type RunDetails,
} from "./reconstruct.js";
