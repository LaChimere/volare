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

export interface AgentLoomErrorInterface {
  code: string;
  message: string;
  cause?: unknown;
}

export interface WorkspaceInterface {
  id: WorkspaceId;
  rootPath: string;
}

export interface ThreadInterface {
  id: ThreadId;
  workspaceId: WorkspaceId;
}

export interface TurnRecordInterface {
  id: TurnId;
  threadId: ThreadId;
  parentTurnId: TurnId | null;
  bridgeSessionId: BridgeSessionId;
  status: TurnStatus;
  model: string;
  createdAt: Date;
  completedAt?: Date;
}

export interface ClientTurnRefInterface {
  protocol: ClientProtocol;
  externalId: string;
  turnId: TurnId;
  threadId: ThreadId;
  parentProtocol?: ClientProtocol;
  parentExternalId?: string;
}

export interface AgentRequestInterface {
  turnId: TurnId;
  threadId: ThreadId;
  workspaceId: WorkspaceId;
  input: AgentInputInterface;
  model: string;
  metadata?: Record<string, unknown>;
}

export interface AgentInputInterface {
  message: string;
  conversationHistory?: ConversationMessageInterface[];
  systemInstructions?: string;
  attachments?: AgentAttachmentInterface[];
  metadata?: Record<string, unknown>;
}

export interface ConversationMessageInterface {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AgentAttachmentInterface {
  kind: 'image' | 'file' | 'other';
  mediaType?: string;
  data?: Uint8Array;
  uri?: string;
}

export interface AgentOutputInterface {
  text?: string;
  items?: unknown[];
  metadata?: Record<string, unknown>;
}

export type AgentEvent =
  | { type: 'turn.created'; turnId: TurnId; emittedAt?: number }
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
      request: PermissionRequestInterface;
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
      output?: AgentOutputInterface;
      usage?: unknown;
      emittedAt?: number;
    }
  | { type: 'turn.failed'; turnId: TurnId; error: unknown; emittedAt?: number }
  | { type: 'turn.cancelled'; turnId: TurnId; emittedAt?: number }
  | { type: 'turn.interrupted'; turnId: TurnId; reason: string; emittedAt?: number };

export interface PermissionRequestInterface {
  action: 'filesystem:write' | 'shell:exec' | 'network:http' | 'destructive' | string;
  scope: {
    path?: string;
    command?: string;
    url?: string;
  };
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkspaceResolverInterface {
  resolve(
    hints: WorkspaceHintsInterface,
    config: ServerConfigInterface,
  ): Promise<WorkspaceInterface>;
}

export interface ServerConfigInterface {
  defaultWorkspaceRoot?: string;
  allowedWorkspaceRoots?: string[];
}

export interface WorkspaceHintsInterface {
  requestedRoot?: string;
  source: 'server-config' | 'client-metadata' | 'process-cwd';
}

export interface NorthboundAdapterInterface {
  readonly protocol: ClientProtocol;
  extractWorkspaceHints(request: NorthboundRequestInterface): Promise<WorkspaceHintsInterface>;
  parseRequest(
    request: NorthboundRequestInterface,
    context: RequestContextInterface,
  ): Promise<AgentRequestInputInterface>;
  encodeStream(
    events: AsyncIterable<AgentEvent>,
    context: ResponseContextInterface,
  ): AsyncIterable<Uint8Array>;
  encodeStoredResponse(record: TurnRecordInterface, events: AgentEvent[]): unknown;
  encodeError(error: AgentLoomErrorInterface): unknown;
  capabilities(): NorthboundCapabilitiesInterface;
}

export interface NorthboundRequestInterface {
  transport: 'http' | 'cli' | 'custom';
  method: string;
  path: string;
  query?: Record<string, string | string[]>;
  headers?: Headers;
  body: unknown;
}

export interface RequestContextInterface {
  workspaceId: WorkspaceId;
  authSubject?: string;
  requestId: string;
}

export interface ResponseContextInterface {
  turnId: TurnId;
  threadId: ThreadId;
  externalResponseId?: string;
}

export interface AgentRequestInputInterface {
  threadId?: ThreadId;
  parentTurnId?: TurnId;
  model: string;
  input: AgentInputInterface;
  metadata?: Record<string, unknown>;
  clientRef?: {
    externalId?: string;
    parentExternalId?: string;
  };
}

export interface NorthboundCapabilitiesInterface {
  streaming: boolean;
  resumableTurns: boolean;
  clientSideToolCalls: boolean;
  cancellation: boolean;
}

export interface ResolvedTurnInterface {
  turn: TurnRecordInterface;
  thread: ThreadInterface;
  session: BackendSessionInterface;
  request: AgentRequestInterface;
}

export interface SessionManagerInterface {
  startTurn(
    input: AgentRequestInputInterface,
    context: RequestContextInterface,
  ): Promise<ResolvedTurnInterface>;
  getTurn(turnId: TurnId): Promise<TurnRecordInterface | null>;
  cancelTurn(turnId: TurnId): Promise<CancelResultInterface>;
}

export interface StateStoreInterface {
  bindClientRef(ref: ClientTurnRefInterface): Promise<void>;
  resolveClientRef(
    protocol: ClientProtocol,
    externalId: string,
  ): Promise<ClientTurnRefInterface | null>;
}

export interface AgentBackendInterface {
  name: string;
  capabilities(): BackendCapabilitiesInterface;
  createSession(
    workspace: WorkspaceInterface,
    options: CreateSessionOptionsInterface,
  ): Promise<BackendSessionInterface>;
  resumeSession(session: BackendSessionInterface): Promise<BackendSessionInterface>;
  send(
    session: BackendSessionInterface,
    request: AgentRequestInterface,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent>;
  submitApprovalDecision?(
    session: BackendSessionInterface,
    approvalId: ApprovalId,
    decision: ApprovalDecision,
  ): Promise<void>;
  cancel(
    session: BackendSessionInterface,
    options?: CancelOptionsInterface,
  ): Promise<CancelResultInterface>;
  disposeSession(session: BackendSessionInterface): Promise<void>;
}

export interface BackendSessionInterface {
  bridgeSessionId: BridgeSessionId;
  backendSessionId?: BackendSessionId;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  status: BackendSessionStatus;
}

export interface BackendProcessMetadataInterface {
  backendSessionId: BackendSessionId;
  processId?: string;
  processStartedAt?: number;
  processIdentityHash?: string;
}

export interface CreateSessionOptionsInterface {
  bridgeSessionId: BridgeSessionId;
  threadId: ThreadId;
  model?: string;
}

export interface CancelOptionsInterface {
  timeoutMs: number;
  forceAfterTimeout: boolean;
}

export interface CancelResultInterface {
  status: 'cancelled' | 'timed_out' | 'not_found';
}

export interface BackendCapabilitiesInterface {
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
