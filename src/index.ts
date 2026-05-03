import { installRuntimeSignalHandlers, startAgentLoomRuntime } from './runtime/server';

const runtime = await startAgentLoomRuntime();
installRuntimeSignalHandlers(runtime);
