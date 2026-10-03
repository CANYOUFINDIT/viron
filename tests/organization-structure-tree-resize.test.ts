/** @vitest-environment happy-dom */
import { defineComponent, ref } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import ElementPlus from "element-plus";
import { afterEach, describe, expect, it, vi } from "vitest";
import OrganizationStructurePanel from "../src/client/views/organization/OrganizationStructurePanel.vue";
import { provideOrganizationContext } from "../src/client/views/organization/context";
import { STRUCTURE_TREE_WIDTH_KEY, clampStructureTreeWidth, preferredStructureTreeWidth } from "../src/client/views/organization/structure-tree-width";
import { i18nPlugin } from "../src/client/i18n";

describe("organization structure tree width", () => {
  it("keeps a saved width between the tree minimum and the room left for the inspector", () => {
    expect(preferredStructureTreeWidth(null)).toBe(330);
    expect(preferredStructureTreeWidth("80")).toBe(72);
    expect(preferredStructureTreeWidth("200")).toBe(72);
    expect(preferredStructureTreeWidth("40")).toBe(72);
    expect(preferredStructureTreeWidth("240")).toBe(240);
    expect(preferredStructureTreeWidth("900")).toBe(560);
    expect(clampStructureTreeWidth(500, 1200)).toBe(500);
    expect(clampStructureTreeWidth(500, 800)).toBe(320);
    expect(clampStructureTreeWidth(500, 600)).toBe(120);
  });
});

describe("organization structure tree resizer", () => {
  const storage = new Map<string, string>();

  afterEach(() => {
    storage.clear();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("drags the architecture column and remembers the width", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
      clear: () => { storage.clear(); },
    });
    vi.stubGlobal("ResizeObserver", class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() { this.callback([{ contentRect: { width: 1200 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      disconnect() {}
      unobserve() {}
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 80, y: 0, left: 80, top: 0, right: 1280, bottom: 700, width: 1200, height: 700, toJSON() { return {}; },
    });
    const wrapper = mount(Host, { attachTo: document.body, global: { plugins: [ElementPlus, i18nPlugin] } });
    await flushPromises();
    const separator = wrapper.get("button[role='separator']");
    expect(separator.attributes("aria-valuenow")).toBe("330");

    separator.element.dispatchEvent(pointer("pointerdown", 80));
    document.dispatchEvent(pointer("pointermove", 500));
    document.dispatchEvent(pointer("pointerup", 500));
    await flushPromises();

    expect(wrapper.get(".structure-workbench").attributes("style")).toContain("--structure-tree-width: 420px");
    expect(separator.attributes("aria-valuenow")).toBe("420");
    expect(storage.get(STRUCTURE_TREE_WIDTH_KEY)).toBe("420");
    expect(document.body.style.cursor).toBe("");
    expect(wrapper.get(".structure-tree").classes()).not.toContain("is-avatar-rail");
    expect(wrapper.findAll(".structure-node__initials").map((node) => node.text())).toEqual(["付", "MB"]);

    separator.element.dispatchEvent(pointer("pointerdown", 80));
    document.dispatchEvent(pointer("pointermove", 160));
    document.dispatchEvent(pointer("pointerup", 160));
    await flushPromises();

    expect(wrapper.get(".structure-workbench").attributes("style")).toContain("--structure-tree-width: 72px");
    expect(separator.attributes("aria-valuenow")).toBe("72");
    expect(storage.get(STRUCTURE_TREE_WIDTH_KEY)).toBe("72");
    expect(wrapper.get(".structure-tree").classes()).toContain("is-avatar-rail");
    expect(wrapper.get(".structure-node[title='付同永']").attributes("title")).toBe("付同永");
    const carets = wrapper.findAll(".el-tree-node__expand-icon");
    expect(carets.some((icon) => !icon.classes().includes("is-leaf"))).toBe(true);
    expect(carets.some((icon) => icon.classes().includes("is-leaf"))).toBe(true);
    wrapper.unmount();
  });
});

const Host = defineComponent({
  setup() {
    provideOrganizationContext({
      activateWorkspace: vi.fn(),
      canManageOrganization: ref(false),
      changeRole: vi.fn(),
      createOrganizationDialog: ref(false),
      deleteProject: vi.fn(),
      detail: ref({
        organization: { name: "onepro", description: "" },
        projects: [],
        members: [],
        grants: [],
      }),
      openCreateProject: vi.fn(),
      openEditGrant: vi.fn(),
      openEditProject: vi.fn(),
      openGrantDialog: vi.fn(),
      openGrantHistory: vi.fn(),
      openProjectMembersById: vi.fn(),
      organizations: ref([]),
      removeMember: vi.fn(),
      revokeGrant: vi.fn(),
      selectStructureNode: vi.fn(),
      selectedGrantRows: ref([]),
      selectedGrantTarget: ref(null),
      selectedMember: ref(null),
      selectedMemberProjects: ref([]),
      selectedNode: ref({ type: "organization", id: "org-1" }),
      selectedProject: ref(null),
      selectedProjectChildren: ref([]),
      selectedProjectPath: ref(""),
      structureTree: ref([{
        key: "organization:org-1",
        type: "organization",
        entityId: "org-1",
        label: "onepro",
        meta: "1 人",
        children: [
          { key: "member:root:u1", type: "member", entityId: "u1", label: "付同永", meta: "成员" },
          { key: "member:root:u2", type: "member", entityId: "u2", label: "Michelle Bill", meta: "成员" },
        ],
      }]),
    } as never);
  },
  components: { OrganizationStructurePanel },
  template: "<OrganizationStructurePanel />",
});

function pointer(type: string, clientX: number): PointerEvent {
  return new PointerEvent(type, { clientX, button: 0, pointerId: 1, bubbles: true, isPrimary: true });
}
