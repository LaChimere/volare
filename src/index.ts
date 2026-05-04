import { installRuntimeSignalHandlers, startVolareRuntime } from './runtime/server';

const runtime = await startVolareRuntime();
installRuntimeSignalHandlers(runtime);
