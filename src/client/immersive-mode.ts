import type { InjectionKey, Ref } from "vue";

export interface ImmersiveModeController {
  active: Readonly<Ref<boolean>>;
  setActive(value: boolean): void;
}

export const immersiveModeKey: InjectionKey<ImmersiveModeController> = Symbol("viron-immersive-mode");
