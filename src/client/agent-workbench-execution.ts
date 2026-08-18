import type {
  AgentWorkbenchDomain,
  AgentWorkbenchExecutionRequest,
  AgentWorkbenchExecutionResult,
} from "../shared/agent";

interface AgentWorkbenchExecutionProvider {
  domain: AgentWorkbenchDomain;
  routePath(): string | null;
  execute(request: AgentWorkbenchExecutionRequest): Promise<AgentWorkbenchExecutionResult>;
  cancel(requestId: string, reason: string): void | Promise<void>;
}

const providers = new Map<AgentWorkbenchDomain, AgentWorkbenchExecutionProvider>();

export function registerAgentWorkbenchExecutionProvider(provider: AgentWorkbenchExecutionProvider): () => void {
  providers.set(provider.domain, provider);
  return () => {
    if (providers.get(provider.domain) === provider) providers.delete(provider.domain);
  };
}

export async function executeAgentWorkbenchRequest(
  routePath: string,
  request: AgentWorkbenchExecutionRequest,
): Promise<AgentWorkbenchExecutionResult> {
  const provider = providers.get(request.domain);
  if (!provider || provider.routePath() !== routePath) throw new Error("请切回 Agent 绑定的目标工作台后重试");
  return provider.execute(request);
}

export function cancelAgentWorkbenchRequest(requestId: string, domain: AgentWorkbenchDomain, reason: string): void {
  void providers.get(domain)?.cancel(requestId, reason);
}
