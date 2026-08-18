interface ScriptActionCollection {
  scriptActions?: unknown[];
}

interface ServiceWithScriptActions extends ScriptActionCollection {
  deployments: ScriptActionCollection[];
}

interface MaintenancePayloadWithScriptActions {
  services: ServiceWithScriptActions[];
}

export function normalizeMaintenanceScriptActions<T extends MaintenancePayloadWithScriptActions>(payload: T): T & { scriptActionsSupported: boolean } {
  const scriptActionsSupported = payload.services.some((service) =>
    "scriptActions" in service || service.deployments.some((deployment) => "scriptActions" in deployment),
  );

  return {
    ...payload,
    scriptActionsSupported,
    services: payload.services.map((service) => ({
      ...service,
      scriptActions: Array.isArray(service.scriptActions) ? service.scriptActions : [],
      deployments: service.deployments.map((deployment) => ({
        ...deployment,
        scriptActions: Array.isArray(deployment.scriptActions) ? deployment.scriptActions : [],
      })),
    })),
  };
}
