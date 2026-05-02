import { AgentLoomError } from '../core/errors';

export function requireBearerAuth(request: Request, apiKey: string): void {
  const origin = request.headers.get('origin');
  if (origin) {
    throw new AgentLoomError('workspace_forbidden', 'Unexpected Origin header');
  }

  const authorization = request.headers.get('authorization');
  if (authorization !== `Bearer ${apiKey}`) {
    throw new AgentLoomError('unauthorized', 'Missing or invalid bearer token');
  }
}
