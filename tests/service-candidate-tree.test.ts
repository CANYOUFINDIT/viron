import { describe, expect, it } from "vitest";
import {
  buildCandidateTree,
  candidateMatchesFilter,
  candidateProviderFacets,
  candidateStatusFacets,
  defaultDiscoveryProvider,
  discoveryProviderFacets,
  discoveryProviderFilters,
  emptyCandidateListFilter,
  filterCandidates,
  kubernetesContextOptions,
  kubernetesNamespaceOptions,
  kubernetesResourceKindOptions,
  type MonitorCandidate,
} from "../src/client/service-candidate-tree.js";

function candidate(
  name: string,
  status: MonitorCandidate["status"],
  metadata: Record<string, unknown>,
): MonitorCandidate {
  return {
    provider: "kubernetes",
    externalId: `k8s:${name}`,
    name,
    status,
    state: status,
    metadata,
  };
}

describe("service candidate tree", () => {
  it("keeps providers at the top level and nests Kubernetes by cluster/context, namespace and resource kind", () => {
    const tree = buildCandidateTree([
      {
        provider: "systemd",
        externalId: "api.service",
        name: "api",
        status: "running",
        state: "active/running",
      },
      candidate("atest-api", "running", { cluster: "cluster1", context: "context-a", namespace: "atest", resourceKind: "Deployment" }),
      candidate("atest-worker", "degraded", { cluster: "cluster1", context: "context-a", namespace: "atest", resourceKind: "StatefulSet" }),
      candidate("cdev-api", "stopped", { cluster: "cluster1", context: "context-a", namespace: "cdev", resourceKind: "Deployment" }),
      candidate("alternate-api", "running", { cluster: "cluster1", context: "context-b", namespace: "atest", resourceKind: "Deployment" }),
      candidate("ingress", "unknown", { cluster: "cluster2", context: "context-c", namespace: "ingress-nginx", resourceKind: "DaemonSet" }),
    ]);

    expect(tree.map((node) => node.label)).toEqual(["systemd", "Kubernetes"]);
    expect(tree[0]).toMatchObject({ total: 1, running: 1, problem: 0, children: [] });

    const kubernetes = tree[1];
    expect(kubernetes).toMatchObject({ total: 5, running: 2, problem: 3, items: [] });
    expect(kubernetes.children.map((node) => [node.label, node.caption, node.total])).toEqual([
      ["cluster1", "context · context-a", 3],
      ["cluster1", "context · context-b", 1],
      ["cluster2", "context · context-c", 1],
    ]);

    const primaryContext = kubernetes.children[0];
    expect(primaryContext.children.map((node) => [node.label, node.total])).toEqual([
      ["atest", 2],
      ["cdev", 1],
    ]);
    expect(primaryContext.children[0].children.map((node) => [node.label, node.total])).toEqual([
      ["Deployment", 1],
      ["StatefulSet", 1],
    ]);
    expect(primaryContext.children[0].children[0].items.map((item) => item.name)).toEqual(["atest-api"]);
  });

  it("uses stable fallbacks when Kubernetes discovery metadata is incomplete", () => {
    const [kubernetes] = buildCandidateTree([candidate("orphan", "unknown", {})]);

    expect(kubernetes.children[0]).toMatchObject({ label: "unknown", caption: "" });
    expect(kubernetes.children[0].children[0]).toMatchObject({ label: "default", caption: "namespace" });
    expect(kubernetes.children[0].children[0].children[0]).toMatchObject({ label: "Workload" });
  });
});

describe("service candidate filters", () => {
  const candidates: MonitorCandidate[] = [
    {
      provider: "systemd",
      externalId: "api.service",
      name: "api",
      status: "running",
      state: "active/running",
    },
    {
      provider: "docker",
      externalId: "deadbeef",
      name: "cache",
      status: "stopped",
      state: "exited",
    },
    candidate("atest-api", "running", { cluster: "cluster1", context: "context-a", namespace: "atest", resourceKind: "Deployment" }),
    candidate("cdev-api", "stopped", { cluster: "cluster1", context: "context-a", namespace: "cdev", resourceKind: "Deployment" }),
    candidate("ingress", "unknown", { cluster: "cluster2", context: "context-c", namespace: "ingress-nginx", resourceKind: "DaemonSet" }),
  ];

  it("filters by query across name, identity and kubernetes metadata", () => {
    expect(filterCandidates(candidates, { ...emptyCandidateListFilter(), query: "atest" }).map((item) => item.name)).toEqual(["atest-api"]);
    expect(filterCandidates(candidates, { ...emptyCandidateListFilter(), query: "deadbeef" }).map((item) => item.name)).toEqual(["cache"]);
    expect(filterCandidates(candidates, { ...emptyCandidateListFilter(), query: "daemonset" }).map((item) => item.name)).toEqual(["ingress"]);
  });

  it("filters by provider and status independently", () => {
    expect(filterCandidates(candidates, { ...emptyCandidateListFilter(), provider: "docker" }).map((item) => item.name)).toEqual(["cache"]);
    expect(filterCandidates(candidates, { ...emptyCandidateListFilter(), status: "stopped" }).map((item) => item.name)).toEqual(["cache", "cdev-api"]);
    expect(candidateMatchesFilter(candidates[0]!, { ...emptyCandidateListFilter(), provider: "kubernetes" })).toBe(false);
  });

  it("narrows kubernetes candidates by context, namespace and resource kind", () => {
    const contextA = JSON.stringify(["cluster1", "context-a"]);
    expect(filterCandidates(candidates, { ...emptyCandidateListFilter(), kubernetesContext: contextA }).map((item) => item.name)).toEqual(["atest-api", "cdev-api"]);
    expect(filterCandidates(candidates, {
      ...emptyCandidateListFilter(),
      kubernetesContext: contextA,
      kubernetesNamespace: "cdev",
      kubernetesResourceKind: "Deployment",
    }).map((item) => item.name)).toEqual(["cdev-api"]);
  });

  it("builds provider, status and kubernetes facet options from the current list", () => {
    expect(candidateProviderFacets(candidates).map((item) => [item.provider, item.total])).toEqual([
      ["systemd", 1],
      ["docker", 1],
      ["kubernetes", 3],
    ]);
    expect(candidateStatusFacets(candidates).map((item) => [item.status, item.total])).toEqual([
      ["running", 2],
      ["stopped", 2],
      ["unknown", 1],
    ]);
    expect(kubernetesContextOptions(candidates).map((item) => [item.label, item.caption, item.total])).toEqual([
      ["cluster1", "context-a", 2],
      ["cluster2", "context-c", 1],
    ]);
    expect(kubernetesNamespaceOptions(candidates, JSON.stringify(["cluster1", "context-a"]))).toEqual(["atest", "cdev"]);
    expect(kubernetesResourceKindOptions(candidates, "", "ingress-nginx")).toEqual(["DaemonSet"]);
  });

  it("defaults discovery to the first of systemd, Docker and Kubernetes that is present", () => {
    expect(discoveryProviderFilters).toEqual(["systemd", "docker", "kubernetes"]);
    expect(defaultDiscoveryProvider(candidates)).toBe("systemd");
    expect(defaultDiscoveryProvider(candidates.filter((item) => item.provider !== "systemd"))).toBe("docker");
    expect(defaultDiscoveryProvider(candidates.filter((item) => item.provider === "kubernetes"))).toBe("kubernetes");
    expect(defaultDiscoveryProvider([])).toBe("systemd");
  });

  it("always exposes systemd, Docker and Kubernetes facets for discovery tabs", () => {
    expect(discoveryProviderFacets(candidates).map((item) => [item.provider, item.total])).toEqual([
      ["systemd", 1],
      ["docker", 1],
      ["kubernetes", 3],
    ]);
    expect(discoveryProviderFacets(candidates.filter((item) => item.provider === "systemd")).map((item) => [item.provider, item.total])).toEqual([
      ["systemd", 1],
      ["docker", 0],
      ["kubernetes", 0],
    ]);
    expect(discoveryProviderFacets([]).map((item) => [item.provider, item.total])).toEqual([
      ["systemd", 0],
      ["docker", 0],
      ["kubernetes", 0],
    ]);
  });
});
