export { initProject, InitConflictError, CONFIG_FILENAME } from "./init.ts";
export type { InitResult } from "./init.ts";
export { EventStore, SourceCursorConflictError } from "./storage/event-store.ts";
export type {
  ConsumerDelivery,
  EventInput,
  EventRecord,
  EventStoreOptions,
  HistoryPage,
  HistoryQuery,
  Json,
  SourceBatch,
  SourceCheckpoint,
  SourcePollWindow,
  PluginRegistration,
  PluginRegistrationInput,
} from "./storage/event-store.ts";

export { deliverConsumerEvent, runConsumerPlugin } from "./consumers/execution.ts";
export type { DeliverConsumerEventOptions, RunConsumerPluginOptions } from "./consumers/execution.ts";

export { DEFAULT_SOURCE_BACKFILL_MS, pollSource } from "./sources/polling.ts";
export type {
  PollSourceOptions,
  PollSourceResult,
  SourceBackfillLimitedDiagnostic,
  SourcePollInput,
  SourcePollPage,
} from "./sources/polling.ts";

export { discoverAndSyncPlugins, discoverPlugins } from "./plugins/discovery.ts";
export type { PluginDiagnostic, PluginDiscoveryOptions, PluginDiscoveryResult } from "./plugins/discovery.ts";
export type {
  ConsumerPluginManifest,
  OAuth2PkceCredential,
  PluginKind,
  PluginManifest,
  SourcePluginManifest,
} from "./plugins/manifest.ts";
export { PluginProcessError, resolvePluginEnvironment, runPluginProcess } from "./plugins/process/executor.ts";
export type { PluginProcessErrorCode, RunPluginProcessOptions, SecretProvider } from "./plugins/process/executor.ts";
export type { PluginErrorCode, PluginModule, PluginStepContext } from "./plugins/process/contract.ts";
export {
  DAILY_CONSUMER_WORKFLOW,
  enqueueConsumerDeliveries,
  EVENT_CONSUMER_WORKFLOW,
  SOURCE_POLL_WORKFLOW,
  syncPluginSchedules,
} from "./scheduling.ts";
export type {
  EnqueueConsumerDeliveriesOptions,
  SyncPluginSchedulesOptions,
  SyncPluginSchedulesResult,
} from "./scheduling.ts";
export { launchAgentLabel, launchAgentPlist, registerLaunchAgent, unregisterLaunchAgent } from "./launch-agent.ts";
export type { LaunchAgentOptions, LaunchAgentResult } from "./launch-agent.ts";
export { openProjectRuntime, projectStatus, tickProject, updateInvocation } from "./operations.ts";
export type { PluginStatus, ProjectRuntime } from "./operations.ts";
export { createPluginWorkflows } from "./workflows.ts";
export type { PluginWorkflowOptions } from "./workflows.ts";

export { SecretBackendError } from "./secrets/backend.ts";
export type { SecretBackend, SecretBackendErrorCode } from "./secrets/backend.ts";
export { KeychainSecretBackend } from "./secrets/keychain.ts";
export type { KeychainSecretBackendOptions } from "./secrets/keychain.ts";
export { SecretConfigurationError, SecretService } from "./secrets/service.ts";
export { OAuthCredentialError, OAuthCredentialService, findOAuthCredential } from "./oauth.ts";
export type { OAuthCredentialBundle, OAuthCredentialStatus } from "./oauth.ts";
export type { SecretStatus } from "./secrets/service.ts";
