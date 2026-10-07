// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import ProtectedWebLogin from "../src/client/components/ProtectedWebLogin.vue";
import type { ProtectedLoginInput, ProtectedLoginState } from "../src/shared/protected-web-login";

function surface(kind: "agreement" | "challenge" = "agreement") {
  const inputs: ProtectedLoginInput[] = [];
  const state: ProtectedLoginState = { phase: "interactive", message: "Read the terms", image: "data:image/png;base64,AA==", revision: "checkbox-frame", width: 500, height: 80, kind };
  const wrapper = mount(ProtectedWebLogin, { props: { state, send: vi.fn(async (input: ProtectedLoginInput) => { inputs.push(input); }) }, global: { stubs: { "el-button": { template: "<button><slot /></button>" } } } });
  const image = wrapper.get("img").element as HTMLImageElement;
  image.setPointerCapture = vi.fn();
  image.getBoundingClientRect = () => ({ x: 0, y: 0, width: 500, height: 80, left: 0, top: 0, right: 500, bottom: 80, toJSON() {} });
  const pointer = (type: string, x: number) => image.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientX: x, clientY: 20, bubbles: true }));
  return { wrapper, inputs, pointer };
}
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe("protected login interaction", () => {
  it("sends a checkbox click once and keeps the coordinates bound to the displayed frame", async () => {
    const { wrapper, inputs, pointer } = surface();
    pointer("pointerdown", 20);
    pointer("pointerup", 20);
    await settle();
    expect(inputs).toEqual([{ type: "click", x: 20, y: 20, revision: "checkbox-frame" }]);
    expect(wrapper.text()).not.toContain("验证码输入框");
    expect(wrapper.find("button").exists()).toBe(false);
    wrapper.unmount();
  });
  it("does not rebind a queued click to a modal that replaced the checkbox", async () => {
    const { wrapper, inputs, pointer } = surface();
    pointer("pointerdown", 20);
    await wrapper.setProps({ state: { ...wrapper.props("state"), revision: "modal-frame", width: 450, height: 220 } });
    pointer("pointerup", 20);
    await settle();
    expect(inputs[0].revision).toBe("checkbox-frame");
    wrapper.unmount();
  });
  it("retains continuous drag input for sliders", async () => {
    const { wrapper, inputs, pointer } = surface("challenge");
    pointer("pointerdown", 20);
    pointer("pointermove", 200);
    pointer("pointerup", 200);
    await settle();
    expect(inputs.map((input) => input.type)).toEqual(["mouseDown", "mouseMove", "mouseUp"]);
    expect(inputs.every((input) => input.revision === "checkbox-frame")).toBe(true);
    expect(wrapper.text()).toContain("验证码输入框");
    expect(wrapper.find("button").text()).toBe("继续登录");
    wrapper.unmount();
  });
});
