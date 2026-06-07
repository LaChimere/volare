export type WorkspaceId = string;
export type ThreadId = string;
export type TurnId = string;
export type BridgeSessionId = string;
export type BackendSessionId = string;
export type ApprovalId = string;
export type ClientProtocol = string;

export type TurnStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type BackendSessionStatus =
  | 'initializing'
  | 'active'
  | 'idle'
  | 'disposing'
  | 'disposed'
  | 'abandoned'
  | 'stale'
  | 'lost';
export type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'timed_out' | 'aborted';

export interface IVolareError {
  code: string;
  message: string;
  cause?: unknown;
}

export interface IWorkspace {
  id: WorkspaceId;
  rootPath: string;
}

export interface IThread {
  id: ThreadId;
  workspaceId: WorkspaceId;
}

export interface ITurnRecord {
  id: TurnId;
  threadId: ThreadId;
  parentTurnId: TurnId | null;
  bridgeSessionId: BridgeSessionId;
  status: TurnStatus;
  model: string;
  createdAt: Date;
  completedAt?: Date;
}

export interface IClientTurnRef {
  protocol: ClientProtocol;
  externalId: string;
  turnId: TurnId;
  threadId: ThreadId;
  parentProtocol?: ClientProtocol;
  parentExternalId?: string;
}

export interface IAgentRequest {
  turnId: TurnId;
  threadId: ThreadId;
  workspaceId: WorkspaceId;
  input: IAgentInput;
  model: string;
  metadata?: Record<string, unknown>;
}

export interface IAgentInput {
  message: string;
  conversationHistory?: IConversationMessage[];
  systemInstructions?: string;
  attachments?: IAgentAttachment[];
  metadata?: Record<string, unknown>;
}

export interface IConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface IAgentAttachment {
  kind: 'image' | 'file' | 'other';
  name?: string;
  mediaType?: string;
  data?: Uint8Array;
  uri?: string;
  metadata?: Record<string, unknown>;
}

export interface IAgentOutput {
  text?: string;
  items?: unknown[];
  metadata?: Record<string, unknown>;
}

export interface IAgentUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimated: boolean;
  source?: string;
}

export type AgentEvent =
  | {
      type: 'turn.created';
      turnId: TurnId;
      requestMetadata?: Record<string, unknown>;
      emittedAt?: number;
    }
  | { type: 'text.delta'; turnId: TurnId; delta: string; emittedAt?: number }
  | { type: 'progress'; turnId: TurnId; message: string; data?: unknown; emittedAt?: number }
  | {
      type: 'tool.observed';
      turnId: TurnId;
      toolName: string;
      input?: unknown;
      output?: unknown;
      emittedAt?: number;
    }
  | {
      type: 'permission.required';
      turnId: TurnId;
      approvalId: ApprovalId;
      request: IPermissionRequest;
      emittedAt?: number;
    }
  | {
      type: 'permission.resolved';
      turnId: TurnId;
      approvalId: ApprovalId;
      decision: 'allow' | 'deny';
      emittedAt?: number;
    }
  | {
      type: 'turn.succeeded';
      turnId: TurnId;
      output?: IAgentOutput;
      usage?: IAgentUsage;
      emittedAt?: number;
    }
  | { type: 'turn.failed'; turnId: TurnId; error: unknown; emittedAt?: number }
  | { type: 'turn.cancelled'; turnId: TurnId; emittedAt?: number }
  | { type: 'turn.interrupted'; turnId: TurnId; reason: string; emittedAt?: number };

export interface IPermissionRequest {
  action: 'filesystem:write' | 'shell:exec' | 'network:http' | 'destructive' | string;
  scope: {
    path?: string;
    command?: string;
    url?: string;
  };
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface IApprovalContext {
  turnId: TurnId;
  threadId: ThreadId;
  workspaceId: WorkspaceId;
  workspaceRootPath: string;
  bridgeSessionId: BridgeSessionId;
  approvalId?: ApprovalId;
}

export type ApprovalEvaluation =
  | { type: 'allow'; request: IPermissionRequest }
  | { type: 'deny'; reason: string; request: IPermissionRequest }
  | { type: 'ask'; approvalId: ApprovalId; timeoutAt: number; request: IPermissionRequest };

export interface IApprovalPolicy {
  evaluate(request: IPermissionRequest, context: IApprovalContext): Promise<ApprovalEvaluation>;
}

export interface IApprovalWaiter {
  awaitDecision(approvalId: ApprovalId, signal?: AbortSignal): Promise<ApprovalDecision>;
}

export interface IApprovalNotifier {
  resolveApproval(input: IApprovalResolutionRequest): Promise<IApprovalResolutionResult>;
  abortPendingApprovals(input: IApprovalAbortPendingInput): Promise<IApprovalAbortPendingResult>;
}

export interface IApprovalProvider extends IApprovalWaiter, IApprovalNotifier {
  evaluate(request: IPermissionRequest, context: IApprovalContext): Promise<ApprovalEvaluation>;
}

export interface IJournalEvent {
  id?: string;
  turnId: TurnId;
  seq?: number;
  kind: 'northbound' | 'backend' | 'canonical' | 'encoded' | 'security';
  redactedRawJson?: unknown;
  canonicalJson?: unknown;
  encodedJson?: unknown;
  redactionJson?: unknown;
  createdAt?: number;
}

export interface IEventJournal {
  append(event: IJournalEvent): Promise<void>;
  listByTurn(turnId: TurnId): Promise<IJournalEvent[]>;
  listByThread(threadId: ThreadId): Promise<IJournalEvent[]>;
  replay(turnId: TurnId): AsyncIterable<AgentEvent>;
  pruneTerminalTurnEvents(input: { completedBefore: number }): Promise<{ prunedTurnCount: number }>;
}

export interface IApprovalRecord {
  id: ApprovalId;
  turnId: TurnId;
  bridgeSessionId: BridgeSessionId;
  status: ApprovalStatus;
  request: IPermissionRequest;
  decision?: ApprovalDecision;
  timeoutAt: number;
  createdAt: Date;
  decidedAt?: Date;
}

export interface IApprovalResolutionInput {
  approvalId: ApprovalId;
  decision: ApprovalDecision;
  journalEvent?: IJournalEvent;
}

export interface IApprovalResolutionRequest {
  approvalId: ApprovalId;
  turnId: TurnId;
  bridgeSessionId: BridgeSessionId;
  decision: ApprovalDecision;
}

export interface IApprovalResolutionResult {
  status: 'resolved' | 'already_terminal';
  decision: ApprovalDecision;
}

export interface IApprovalAbortPendingInput {
  reason: string;
}

export interface IApprovalAbortPendingResult {
  abortedApprovalCount: number;
}

export interface IStartupRecoveryResult {
  interruptedTurnCount: number;
  abandonedSessionCount: number;
  abortedApprovalCount: number;
}

export interface IIdleSessionPruneResult {
  prunedSessionCount: number;
}

export interface IShutdownResult extends IStartupRecoveryResult {}

export interface IShutdownController {
  shutdown(): Promise<IShutdownResult>;
}

export interface IWorkspaceResolver {
  resolve(hints: IWorkspaceHints, config: IServerConfig): Promise<IWorkspace>;
}

export interface IServerConfig {
  defaultWorkspaceRoot?: string;
  allowedWorkspaceRoots?: string[];
  projectlessWorkspaceRoot?: string;
}

export interface IWorkspaceHints {
  requestedRoot?: string;
  source:
    | 'server-config'
    | 'client-metadata'
    | 'request-header'
    | 'client-context'
    | 'process-cwd'
    | 'projectless';
}

export interface INorthboundAdapter {
  readonly protocol: ClientProtocol;
  extractWorkspaceHints(request: INorthboundRequest): Promise<IWorkspaceHints>;
  parseRequest(request: INorthboundRequest, context: IRequestContext): Promise<IAgentRequestInput>;
  encodeStream(
    events: AsyncIterable<AgentEvent>,
    context: IResponseContext,
  ): AsyncIterable<Uint8Array>;
  encodeStoredResponse(
    record: ITurnRecord,
    events: AgentEvent[],
    options?: { previousResponseId?: string | null; metadata?: Record<string, unknown> },
  ): unknown;
  encodeError(error: IVolareError): unknown;
  capabilities(): INorthboundCapabilities;
}

export interface INorthboundRequest {
  transport: 'http' | 'cli' | 'custom';
  method: string;
  path: string;
  query?: Record<string, string | string[]>;
  headers?: Headers;
  body: unknown;
}

export interface IRequestContext {
  workspaceId: WorkspaceId;
  authSubject?: string;
  requestId: string;
  signal?: AbortSignal;
}

export interface IResponseContext {
  turnId: TurnId;
  threadId: ThreadId;
  parentTurnId?: TurnId | null;
  bridgeSessionId?: BridgeSessionId;
  externalResponseId?: string;
  previousResponseId?: string | null;
  requestInput?: IAgentInput;
  requestMetadata?: Record<string, unknown>;
  model?: string;
  createdAt?: Date;
}

export interface IAgentRequestInput {
  threadId?: ThreadId;
  parentTurnId?: TurnId;
  model: string;
  input: IAgentInput;
  metadata?: Record<string, unknown>;
  clientRef?: {
    protocol: ClientProtocol;
    externalId: string;
    parentProtocol?: ClientProtocol;
    parentExternalId?: string;
  };
}

export interface INorthboundCapabilities {
  streaming: boolean;
  resumableTurns: boolean;
  clientSideToolCalls: boolean;
  cancellation: boolean;
}

export interface IResolvedTurn {
  turn: ITurnRecord;
  thread: IThread;
  session: IBackendSession;
  request: IAgentRequest;
  externalResponseId?: string;
}

export interface ISessionManager {
  startTurn(input: IAgentRequestInput, context: IRequestContext): Promise<IResolvedTurn>;
  getTurn(turnId: TurnId): Promise<ITurnRecord | null>;
  getEvents(turnId: TurnId): AgentEvent[];
  streamTurn(resolved: IResolvedTurn, signal?: AbortSignal): AsyncIterable<AgentEvent>;
  cancelTurn(turnId: TurnId): Promise<ICancelResult>;
}

export interface IStateStore {
  getOrCreateWorkspace(input: { rootPath: string }): Promise<IWorkspace>;
  getWorkspace(workspaceId: WorkspaceId): Promise<IWorkspace | null>;
  getWorkspaceByPath(rootPath: string): Promise<IWorkspace | null>;
  createThread(input: { workspaceId: WorkspaceId }): Promise<IThread>;
  getThread(threadId: ThreadId): Promise<IThread | null>;
  createTurn(input: {
    threadId: ThreadId;
    parentTurnId?: TurnId;
    bridgeSessionId: BridgeSessionId;
    model: string;
  }): Promise<ITurnRecord>;
  getTurn(turnId: TurnId): Promise<ITurnRecord | null>;
  updateTurnStatus(
    turnId: TurnId,
    fromStatus: ITurnRecord['status'] | 'any-non-terminal',
    toStatus: ITurnRecord['status'],
    completedAt?: number,
  ): Promise<boolean>;
  bindClientRef(ref: IClientTurnRef): Promise<void>;
  resolveClientRef(protocol: ClientProtocol, externalId: string): Promise<IClientTurnRef | null>;
  reserveBackendSession(input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    backend: string;
  }): Promise<IBackendSession>;
  activateBackendSession(
    session: IBackendSession,
    metadata: IBackendProcessMetadata,
  ): Promise<void>;
  updateBackendSessionStatus(
    bridgeSessionId: BridgeSessionId,
    fromStatus: BackendSessionStatus | 'any',
    toStatus: BackendSessionStatus,
  ): Promise<boolean>;
  getBackendSession(bridgeSessionId: BridgeSessionId): Promise<IBackendSession | null>;
  getBackendSessionByThread(threadId: ThreadId): Promise<IBackendSession | null>;
  createApproval(input: {
    approvalId?: ApprovalId;
    turnId: TurnId;
    bridgeSessionId: BridgeSessionId;
    request: IPermissionRequest;
    timeoutAt: number;
    journalEvent?: IJournalEvent;
  }): Promise<IApprovalRecord>;
  getApproval(approvalId: ApprovalId): Promise<IApprovalRecord | null>;
  listPendingApprovals(): Promise<IApprovalRecord[]>;
  resolveApprovalWithJournal(input: IApprovalResolutionInput): Promise<IApprovalResolutionResult>;
  recoverStartupState(input?: {
    now?: number;
    approvalAbortReason?: string;
  }): Promise<IStartupRecoveryResult>;
  pruneIdleBackendSessions(input: {
    updatedBefore: number;
    now?: number;
  }): Promise<IIdleSessionPruneResult>;
}

export interface IAgentBackend {
  name: string;
  capabilities(): IBackendCapabilities;
  createSession(workspace: IWorkspace, options: ICreateSessionOptions): Promise<IBackendSession>;
  resumeSession(session: IBackendSession, signal?: AbortSignal): Promise<IBackendSession>;
  send(
    session: IBackendSession,
    request: IAgentRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent>;
  submitApprovalDecision?(
    session: IBackendSession,
    approvalId: ApprovalId,
    decision: ApprovalDecision,
  ): Promise<void>;
  cancel(session: IBackendSession, options?: ICancelOptions): Promise<ICancelResult>;
  disposeSession(session: IBackendSession): Promise<void>;
}

export interface IBackendSession {
  bridgeSessionId: BridgeSessionId;
  backendSessionId?: BackendSessionId;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  status: BackendSessionStatus;
}

export interface IBackendProcessMetadata {
  backendSessionId: BackendSessionId;
  processId?: string;
  processStartedAt?: number;
  processIdentityHash?: string;
}

export interface ICreateSessionOptions {
  bridgeSessionId: BridgeSessionId;
  threadId: ThreadId;
  model?: string;
  signal?: AbortSignal;
}

export interface ICancelOptions {
  timeoutMs: number;
  forceAfterTimeout: boolean;
}

export interface ICancelResult {
  status: 'cancelled' | 'already_terminal' | 'timed_out' | 'not_found';
}

export interface IBackendCapabilities {
  persistentSessions: boolean;
  serverSideTools: boolean;
  permissionRequests: boolean;
  externalApprovalDecisions: boolean;
  backendInternalPauseResume: boolean;
  cancellation: boolean;
}

export type ApprovalDecision =
  | { type: 'allow'; scope: 'once' | 'always' }
  | { type: 'deny'; scope: 'once' | 'always'; reason?: string }
  | { type: 'timeout'; reason: string }
  | { type: 'aborted'; reason: string };
