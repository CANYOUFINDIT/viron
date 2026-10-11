import { translate as tr } from "../../i18n";
import { ElMessage } from "element-plus";
import { computed, ref } from "vue";
import { api } from "../../api";
import { reorderIds, sameOrder } from "../../../shared/tab-order";

import type { MaintenanceDirectory, DirectoryMoveDirection, DirectoryDropTarget, MaintenancePanelProps } from "./types";
import { deferMaintenancePart, type MaintenanceContext } from "./context";

export function useMaintenanceDirectory(ctx: MaintenanceContext, props: Readonly<MaintenancePanelProps>) {
  const $payload = deferMaintenancePart(ctx, "payload");
  const draggingDirectory = ref<{
      kind: MaintenanceDirectory;
      id: string;
  } | null>(null);

  const serviceDropTarget = ref<DirectoryDropTarget | null>(null);

  const hostDropTarget = ref<DirectoryDropTarget | null>(null);

  const savingServiceOrder = ref(false);

  const savingHostOrder = ref(false);

  const canSortDirectory = computed(() => $payload.payload.value.canConfigure && !savingServiceOrder.value && !savingHostOrder.value);

  function directoryIds(kind: MaintenanceDirectory): string[] {
      return kind === "service"
          ? $payload.payload.value.services.map((item) => item.id)
          : $payload.payload.value.hosts.map((item) => item.sshConnectionId);
  }

  function orderedDirectoryItems<T>(items: T[], orderedIds: string[], id: (item: T) => string): T[] {
      const byId = new Map(items.map((item) => [id(item), item]));
      return orderedIds.map((itemId) => byId.get(itemId)).filter((item): item is T => Boolean(item));
  }

  function directoryDropTarget(kind: MaintenanceDirectory) {
      return kind === "service" ? serviceDropTarget : hostDropTarget;
  }

  function insertAfterDirectoryTarget(event: DragEvent): boolean {
      const element = event.currentTarget;
      if (!(element instanceof HTMLElement))
          return false;
      const bounds = element.getBoundingClientRect();
      return event.clientY > bounds.top + bounds.height / 2;
  }

  function startDirectoryDrag(kind: MaintenanceDirectory, id: string, event: DragEvent) {
      if (!canSortDirectory.value) {
          event.preventDefault();
          return;
      }
      draggingDirectory.value = { kind, id };
      if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", `maintenance-${kind}:${id}`);
      }
  }

  function dragDirectoryOver(kind: MaintenanceDirectory, id: string, event: DragEvent) {
      if (!draggingDirectory.value || draggingDirectory.value.kind !== kind || draggingDirectory.value.id === id)
          return;
      event.preventDefault();
      if (event.dataTransfer)
          event.dataTransfer.dropEffect = "move";
      directoryDropTarget(kind).value = { id, after: insertAfterDirectoryTarget(event) };
  }

  function leaveDirectoryDropTarget(kind: MaintenanceDirectory, event: DragEvent) {
      const element = event.currentTarget;
      const nextTarget = event.relatedTarget;
      const target = directoryDropTarget(kind);
      if (!(element instanceof HTMLElement) || target.value?.id !== element.dataset.directoryId)
          return;
      if (!(nextTarget instanceof Node && element.contains(nextTarget)))
          target.value = null;
  }

  async function persistDirectoryOrder(kind: MaintenanceDirectory, orderedIds: string[]) {
      const currentIds = directoryIds(kind);
      if (sameOrder(currentIds, orderedIds))
          return;
      if (kind === "service") {
          const original = [...$payload.payload.value.services];
          $payload.payload.value.services = orderedDirectoryItems(original, orderedIds, (item) => item.id);
          savingServiceOrder.value = true;
          try {
              await api(`/api/v1/environments/${props.environmentId}/services/order`, {
                  method: "PUT",
                  body: JSON.stringify({ orderedIds }),
              });
          }
          catch (error) {
              $payload.payload.value.services = original;
              ElMessage.error(error instanceof Error ? error.message : tr("保存服务清单顺序失败"));
          }
          finally {
              savingServiceOrder.value = false;
          }
          return;
      }
      const original = [...$payload.payload.value.hosts];
      $payload.payload.value.hosts = orderedDirectoryItems(original, orderedIds, (item) => item.sshConnectionId);
      savingHostOrder.value = true;
      try {
          await api(`/api/v1/environments/${props.environmentId}/maintenance-hosts/order`, {
              method: "PUT",
              body: JSON.stringify({ orderedIds }),
          });
      }
      catch (error) {
          $payload.payload.value.hosts = original;
          ElMessage.error(error instanceof Error ? error.message : tr("保存宿主机顺序失败"));
      }
      finally {
          savingHostOrder.value = false;
      }
  }

  async function dropDirectoryItem(kind: MaintenanceDirectory, id: string, event: DragEvent) {
      if (!draggingDirectory.value || draggingDirectory.value.kind !== kind)
          return;
      event.preventDefault();
      const orderedIds = reorderIds(directoryIds(kind), draggingDirectory.value.id, id, insertAfterDirectoryTarget(event));
      endDirectoryDrag();
      await persistDirectoryOrder(kind, orderedIds);
  }

  function endDirectoryDrag() {
      draggingDirectory.value = null;
      serviceDropTarget.value = null;
      hostDropTarget.value = null;
  }

  function canMoveDirectoryItem(kind: MaintenanceDirectory, id: string, direction: DirectoryMoveDirection) {
      const ids = directoryIds(kind);
      const index = ids.indexOf(id);
      return index >= 0 && (direction === "up" ? index > 0 : index < ids.length - 1);
  }

  async function moveDirectoryItem(kind: MaintenanceDirectory, id: string, direction: DirectoryMoveDirection) {
      if (!canSortDirectory.value || !canMoveDirectoryItem(kind, id, direction))
          return;
      const orderedIds = directoryIds(kind);
      const index = orderedIds.indexOf(id);
      const target = direction === "up" ? index - 1 : index + 1;
      [orderedIds[index], orderedIds[target]] = [orderedIds[target]!, orderedIds[index]!];
      await persistDirectoryOrder(kind, orderedIds);
  }

  function handleDirectoryMove(kind: MaintenanceDirectory, id: string, command: string | number | object) {
      if (command === "up" || command === "down")
          void moveDirectoryItem(kind, id, command);
  }

  return {
    draggingDirectory,
    serviceDropTarget,
    hostDropTarget,
    savingServiceOrder,
    savingHostOrder,
    canSortDirectory,
    directoryIds,
    orderedDirectoryItems,
    directoryDropTarget,
    insertAfterDirectoryTarget,
    startDirectoryDrag,
    dragDirectoryOver,
    leaveDirectoryDropTarget,
    persistDirectoryOrder,
    dropDirectoryItem,
    endDirectoryDrag,
    canMoveDirectoryItem,
    moveDirectoryItem,
    handleDirectoryMove,
  };
}
