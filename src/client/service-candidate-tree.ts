import { translate as tr } from "./i18n";

export type CandidateStatus = "running" | "stopped" | "degraded" | "unknown";
export type Provider = "systemd" | "docker" | "podman" | "supervisor" | "kubernetes" | "process";

export interface MonitorCandidate {
  provider: Provider;
  externalId: string;
  name: string;
  group?: string;
  status: CandidateStatus;
  state: string;
  pid?: number;
  cpuUsedPercent?: number;
  memoryBytes?: number;
  restartCount?: number;
  uptimeSeconds?: number;
  metadata?: Record<string, unknown>;
}

export type CandidateTreeNodeKind = "provider" | "cluster" | "namespace" | "resource";

export interface CandidateTreeNode {
  key: string;
  label: string;
  caption: string;
  kind: CandidateTreeNodeKind;
  provider: Provider;
  items: MonitorCandidate[];
  children: CandidateTreeNode[];
  total: number;
  running: number;
  problem: number;
}

const providerOrder: Provider[] = ["systemd", "docker", "podman", "supervisor", "kubernetes", "process"];

export function providerLabel(provider: Provider): string {
  return ({ systemd: "systemd", docker: "Docker", podman: "Podman", supervisor: "Supervisor", kubernetes: "Kubernetes", process: tr("普通进程") } as Record<Provider, string>)[provider];
}

export function candidateDetail(candidate: MonitorCandidate): string {
  if (candidate.provider !== "kubernetes") return candidate.state;
  const services = Array.isArray(candidate.metadata?.services)
    ? candidate.metadata.services.filter((item): item is string => typeof item === "string")
    : [];
  return services.length ? `${candidate.state} · Service ${services.join(", ")}` : candidate.state;
}

function sortByLabel<T extends { label: string }>(items: T[]): T[] {
  return items.sort((left, right) => left.label.localeCompare(right.label, "zh-CN", { numeric: true }));
}

function nodeStats(candidates: readonly MonitorCandidate[]) {
  const running = candidates.filter((candidate) => candidate.status === "running").length;
  return { total: candidates.length, running, problem: candidates.length - running };
}

interface KubernetesLevel {
  kind: Exclude<CandidateTreeNodeKind, "provider">;
  identity: (candidate: MonitorCandidate) => { key: string; label: string; caption: string };
}

const kubernetesLevels: KubernetesLevel[] = [
  {
    kind: "cluster",
    identity(candidate) {
      const cluster = String(candidate.metadata?.cluster ?? "");
      const context = String(candidate.metadata?.context ?? "");
      return {
        key: JSON.stringify([cluster, context]),
        label: cluster || context || "unknown",
        caption: context ? `context · ${context}` : "",
      };
    },
  },
  {
    kind: "namespace",
    identity(candidate) {
      const namespace = String(candidate.metadata?.namespace ?? "default");
      return { key: namespace, label: namespace, caption: "namespace" };
    },
  },
  {
    kind: "resource",
    identity(candidate) {
      const resourceKind = String(candidate.metadata?.resourceKind ?? "Workload");
      return { key: resourceKind, label: resourceKind, caption: tr("资源类型") };
    },
  },
];

function buildKubernetesLevel(candidates: MonitorCandidate[], levelIndex: number, parentKey: string): CandidateTreeNode[] {
  const level = kubernetesLevels[levelIndex];
  const buckets = new Map<string, { label: string; caption: string; candidates: MonitorCandidate[] }>();
  for (const candidate of candidates) {
    const identity = level.identity(candidate);
    const bucket = buckets.get(identity.key) ?? { label: identity.label, caption: identity.caption, candidates: [] };
    bucket.candidates.push(candidate);
    buckets.set(identity.key, bucket);
  }

  return sortByLabel([...buckets.entries()].map(([bucketKey, bucket]) => {
    const key = `${parentKey}:${level.kind}:${bucketKey}`;
    const isLeaf = levelIndex === kubernetesLevels.length - 1;
    return {
      key,
      label: bucket.label,
      caption: bucket.caption,
      kind: level.kind,
      provider: "kubernetes" as const,
      items: isLeaf ? [...bucket.candidates].sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true })) : [],
      children: isLeaf ? [] : buildKubernetesLevel(bucket.candidates, levelIndex + 1, key),
      ...nodeStats(bucket.candidates),
    };
  }));
}

export function buildCandidateTree(candidates: readonly MonitorCandidate[]): CandidateTreeNode[] {
  const byProvider = new Map<Provider, MonitorCandidate[]>();
  for (const candidate of candidates) {
    const items = byProvider.get(candidate.provider) ?? [];
    items.push(candidate);
    byProvider.set(candidate.provider, items);
  }

  return providerOrder.flatMap((provider) => {
    const items = byProvider.get(provider);
    if (!items?.length) return [];
    const key = `provider:${provider}`;
    return [{
      key,
      label: providerLabel(provider),
      caption: "",
      kind: "provider" as const,
      provider,
      items: provider === "kubernetes" ? [] : items,
      children: provider === "kubernetes" ? buildKubernetesLevel(items, 0, key) : [],
      ...nodeStats(items),
    }];
  });
}

export type CandidateStatusFilter = "all" | CandidateStatus;
export type CandidateProviderFilter = "all" | Provider;

export interface CandidateListFilter {
  query: string;
  provider: CandidateProviderFilter;
  status: CandidateStatusFilter;
  kubernetesContext: string;
  kubernetesNamespace: string;
  kubernetesResourceKind: string;
}

export interface CandidateProviderFacet {
  provider: Provider;
  label: string;
  total: number;
  running: number;
  problem: number;
}

export interface CandidateStatusFacet {
  status: CandidateStatus;
  total: number;
}

export interface KubernetesContextOption {
  key: string;
  label: string;
  caption: string;
  total: number;
}

export const discoveryProviderFilters: Provider[] = ["systemd", "docker", "kubernetes"];

export function emptyCandidateListFilter(): CandidateListFilter {
  return {
    query: "",
    provider: "all",
    status: "all",
    kubernetesContext: "",
    kubernetesNamespace: "",
    kubernetesResourceKind: "",
  };
}

export function defaultDiscoveryProvider(candidates: readonly MonitorCandidate[]): Provider {
  const present = new Set(candidates.map((candidate) => candidate.provider));
  return discoveryProviderFilters.find((provider) => present.has(provider)) ?? discoveryProviderFilters[0]!;
}

export function resetDiscoveryFilter(candidates: readonly MonitorCandidate[]): CandidateListFilter {
  return { ...emptyCandidateListFilter(), provider: defaultDiscoveryProvider(candidates) };
}

export function candidateKey(candidate: Pick<MonitorCandidate, "provider" | "externalId">): string {
  return `${candidate.provider}:${candidate.externalId}`;
}

export function kubernetesIdentity(candidate: MonitorCandidate) {
  const metadata = candidate.metadata ?? {};
  return {
    cluster: String(metadata.cluster ?? ""),
    context: String(metadata.context ?? ""),
    namespace: String(metadata.namespace ?? "default"),
    resourceKind: String(metadata.resourceKind ?? "Workload"),
  };
}

export function kubernetesContextKey(candidate: MonitorCandidate): string {
  const identity = kubernetesIdentity(candidate);
  return JSON.stringify([identity.cluster, identity.context]);
}

export function isCandidateFilterActive(filter: CandidateListFilter): boolean {
  return Boolean(
    filter.query.trim()
    || filter.provider !== "all"
    || filter.status !== "all"
    || filter.kubernetesContext
    || filter.kubernetesNamespace
    || filter.kubernetesResourceKind,
  );
}

function candidateSearchHaystack(candidate: MonitorCandidate): string {
  const identity = kubernetesIdentity(candidate);
  return [
    candidate.name,
    candidate.externalId,
    candidate.state,
    candidate.group,
    providerLabel(candidate.provider),
    candidate.provider,
    identity.cluster,
    identity.context,
    identity.namespace,
    identity.resourceKind,
  ].filter(Boolean).join("\0").toLowerCase();
}

export function candidateMatchesFilter(candidate: MonitorCandidate, filter: CandidateListFilter): boolean {
  if (filter.provider !== "all" && candidate.provider !== filter.provider) return false;
  if (filter.status !== "all" && candidate.status !== filter.status) return false;
  if (filter.kubernetesContext || filter.kubernetesNamespace || filter.kubernetesResourceKind) {
    if (candidate.provider !== "kubernetes") return false;
    const identity = kubernetesIdentity(candidate);
    if (filter.kubernetesContext && kubernetesContextKey(candidate) !== filter.kubernetesContext) return false;
    if (filter.kubernetesNamespace && identity.namespace !== filter.kubernetesNamespace) return false;
    if (filter.kubernetesResourceKind && identity.resourceKind !== filter.kubernetesResourceKind) return false;
  }
  const query = filter.query.trim().toLowerCase();
  if (query && !candidateSearchHaystack(candidate).includes(query)) return false;
  return true;
}

export function filterCandidates(candidates: readonly MonitorCandidate[], filter: CandidateListFilter): MonitorCandidate[] {
  return candidates
    .filter((candidate) => candidateMatchesFilter(candidate, filter))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
}

export function candidateProviderFacets(candidates: readonly MonitorCandidate[]): CandidateProviderFacet[] {
  const counts = new Map<Provider, { total: number; running: number; problem: number }>();
  for (const candidate of candidates) {
    const bucket = counts.get(candidate.provider) ?? { total: 0, running: 0, problem: 0 };
    bucket.total += 1;
    if (candidate.status === "running") bucket.running += 1;
    else bucket.problem += 1;
    counts.set(candidate.provider, bucket);
  }
  return providerOrder.flatMap((provider) => {
    const bucket = counts.get(provider);
    if (!bucket) return [];
    return [{ provider, label: providerLabel(provider), ...bucket }];
  });
}

export function discoveryProviderFacets(candidates: readonly MonitorCandidate[]): CandidateProviderFacet[] {
  const counts = new Map(candidateProviderFacets(candidates).map((facet) => [facet.provider, facet]));
  return discoveryProviderFilters.map((provider) => counts.get(provider) ?? {
    provider,
    label: providerLabel(provider),
    total: 0,
    running: 0,
    problem: 0,
  });
}

export function candidateStatusFacets(candidates: readonly MonitorCandidate[]): CandidateStatusFacet[] {
  const statuses: CandidateStatus[] = ["running", "stopped", "degraded", "unknown"];
  return statuses
    .map((status) => ({ status, total: candidates.filter((candidate) => candidate.status === status).length }))
    .filter((item) => item.total > 0);
}

export function kubernetesContextOptions(candidates: readonly MonitorCandidate[]): KubernetesContextOption[] {
  const buckets = new Map<string, { label: string; caption: string; total: number }>();
  for (const candidate of candidates) {
    if (candidate.provider !== "kubernetes") continue;
    const identity = kubernetesIdentity(candidate);
    const key = kubernetesContextKey(candidate);
    const bucket = buckets.get(key) ?? {
      label: identity.cluster || identity.context || "unknown",
      caption: identity.context,
      total: 0,
    };
    bucket.total += 1;
    buckets.set(key, bucket);
  }
  return sortByLabel([...buckets.entries()].map(([key, value]) => ({ key, ...value })));
}

export function kubernetesNamespaceOptions(candidates: readonly MonitorCandidate[], contextKey = ""): string[] {
  const names = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.provider !== "kubernetes") continue;
    if (contextKey && kubernetesContextKey(candidate) !== contextKey) continue;
    names.add(kubernetesIdentity(candidate).namespace);
  }
  return [...names].sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }));
}

export function kubernetesResourceKindOptions(
  candidates: readonly MonitorCandidate[],
  contextKey = "",
  namespace = "",
): string[] {
  const kinds = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.provider !== "kubernetes") continue;
    const identity = kubernetesIdentity(candidate);
    if (contextKey && kubernetesContextKey(candidate) !== contextKey) continue;
    if (namespace && identity.namespace !== namespace) continue;
    kinds.add(identity.resourceKind);
  }
  return [...kinds].sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }));
}
