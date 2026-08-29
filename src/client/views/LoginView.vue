<script setup lang="ts">import { translate as tr } from "../i18n";

import { ArrowRight, Database, Globe2, Server, ShieldCheck, TerminalSquare } from "@lucide/vue";
import { ElMessage } from "element-plus";
import gsap from "gsap";
import { nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import ShapeGrid from "../components/ShapeGrid.vue";
import ShuffleText from "../components/ShuffleText.vue";
import { desktopState, isDesktopApp, selectDesktopEndpoint, type DesktopState } from "../desktop";
import { login, register as registerUser } from "../session";
import { theme } from "../theme";
import vironLogoUrl from "../../../design/logo/viron-logo.svg?url";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const registering = ref(false);
const rememberPassword = ref(false);
const desktop = isDesktopApp();
const endpoint = ref("");
const endpointState = ref<DesktopState | null>(null);
const form = reactive({ username: "", password: "", confirmPassword: "" });
const environmentTitle = ref<HTMLElement | null>(null);
const environmentTitleReady = ref(false);
const capabilityGrid = ref<HTMLElement | null>(null);
const capabilityGridReady = ref(false);
const loginFormElement = ref<HTMLFormElement | null>(null);
const loginFormReady = ref(false);
const REMEMBERED_LOGIN_KEY = "envman.login.rememberedCredentials";
let environmentTitleMedia: ReturnType<typeof gsap.matchMedia> | null = null;
let loginFormMedia: ReturnType<typeof gsap.matchMedia> | null = null;
let environmentRevealStarted = false;

type RememberedLogin = {
  username: string;
  password: string;
};

function loginStorage() {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

function clearRememberedLogin() {
  try {
    loginStorage()?.removeItem(REMEMBERED_LOGIN_KEY);
  } catch {
    // Ignore storage permission failures; they should not block login.
  }
}

function loadRememberedLogin() {
  if (desktop) {
    clearRememberedLogin();
    return;
  }
  const storage = loginStorage();
  if (!storage) return;

  try {
    const raw = storage.getItem(REMEMBERED_LOGIN_KEY);
    if (!raw) return;
    const remembered = JSON.parse(raw) as Partial<RememberedLogin>;
    if (typeof remembered.username !== "string" || typeof remembered.password !== "string") {
      clearRememberedLogin();
      return;
    }
    form.username = remembered.username;
    form.password = remembered.password;
    rememberPassword.value = true;
  } catch {
    clearRememberedLogin();
  }
}

function saveRememberedLogin() {
  if (desktop) {
    clearRememberedLogin();
    return;
  }
  const storage = loginStorage();
  if (!storage) return;

  if (!rememberPassword.value) {
    clearRememberedLogin();
    return;
  }

  try {
    storage.setItem(REMEMBERED_LOGIN_KEY, JSON.stringify({
      username: form.username,
      password: form.password,
    }));
  } catch {
    ElMessage.warning(tr("浏览器当前无法保存登录信息"));
  }
}

function handleRememberChange(value: string | number | boolean) {
  if (!Boolean(value)) clearRememberedLogin();
}

async function submit() {
  if (desktop && !endpoint.value.trim()) {
    ElMessage.warning(tr("请输入 Viron Endpoint"));
    return;
  }
  if (!form.username || !form.password) {
    ElMessage.warning(tr("请输入用户名和密码"));
    return;
  }
  if (registering.value && form.password !== form.confirmPassword) {
    ElMessage.warning(tr("两次输入的密码不一致"));
    return;
  }
  loading.value = true;
  try {
    if (desktop && endpointState.value?.endpoint !== endpoint.value.trim().replace(/\/$/, "")) {
      endpointState.value = await selectDesktopEndpoint(endpoint.value);
      endpoint.value = endpointState.value.endpoint ?? endpoint.value;
    }
    if (registering.value) await registerUser(form.username, form.password);
    else {
      await login(form.username, form.password);
      saveRememberedLogin();
    }
    const redirect = typeof route.query.redirect === "string" ? route.query.redirect : { name: "monitoring" };
    await router.replace(redirect);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("登录失败"));
  } finally {
    loading.value = false;
  }
}

function toggleRegistering() {
  registering.value = !registering.value;
  form.confirmPassword = "";
  if (registering.value) rememberPassword.value = false;
}

async function revealEnvironmentTitle() {
  if (environmentRevealStarted) return;
  environmentRevealStarted = true;
  if (document.fonts?.status !== "loaded") await document.fonts?.ready;
  await nextTick();

  const root = environmentTitle.value;
  if (!root) return;

  const prefix = root.querySelector<HTMLElement>("[data-environment-prefix]");
  const suffix = root.querySelector<HTMLElement>("[data-environment-suffix]");
  const vironLetters = root.querySelectorAll<HTMLElement>(".environment-title__viron-letter");
  const capabilityCards = capabilityGrid.value?.querySelectorAll<HTMLElement>("article") ?? [];

  if (!prefix || !suffix || vironLetters.length === 0) {
    environmentTitleReady.value = true;
    capabilityGridReady.value = true;
    return;
  }

  const animatedElements = [prefix, suffix, ...vironLetters, ...capabilityCards];
  const setStartState = () => {
    gsap.set(vironLetters, {
      autoAlpha: 0,
      yPercent: 92,
      scaleY: 0.48,
      transformOrigin: "50% 100%",
    });
    gsap.set(prefix, { autoAlpha: 0, xPercent: -220 });
    gsap.set(suffix, { autoAlpha: 0, xPercent: 105 });
    gsap.set(capabilityCards, { autoAlpha: 0, y: 18 });
  };

  setStartState();
  environmentTitleReady.value = true;
  capabilityGridReady.value = true;
  await nextTick();

  environmentTitleMedia = gsap.matchMedia();
  environmentTitleMedia.add(
    {
      isDesktop: "(min-width: 901px)",
      reduceMotion: "(prefers-reduced-motion: reduce)",
    },
    (context) => {
      const { reduceMotion } = context.conditions as { reduceMotion: boolean };

      if (reduceMotion) {
        gsap.set(animatedElements, { clearProps: "transform,opacity,visibility" });
        return;
      }

      setStartState();
      const timeline = gsap.timeline({
        delay: 0.24,
        defaults: { ease: "power3.out" },
        onComplete: () => {
          gsap.set(animatedElements, { clearProps: "transform,opacity,visibility" });
        },
      });
      timeline
        .to(vironLetters, {
          autoAlpha: 1,
          yPercent: 0,
          scaleY: 1,
          duration: 0.5,
          stagger: 0.065,
        })
        .addLabel("assemble", "+=0.18")
        .to(prefix, { autoAlpha: 1, xPercent: 0, duration: 0.7, ease: "power4.out" }, "assemble")
        .to(suffix, { autoAlpha: 1, xPercent: 0, duration: 0.7, ease: "power4.out" }, "assemble")
        .addLabel("capabilities", "assemble+=0.7")
        .to(capabilityCards, {
          autoAlpha: 1,
          y: 0,
          duration: 0.62,
          stagger: 0.11,
          ease: "power2.out",
        }, "capabilities");
    },
    root,
  );
}

async function revealLoginForm() {
  await nextTick();
  const formElement = loginFormElement.value;
  if (!formElement) return;

  gsap.set(formElement, { autoAlpha: 0 });
  loginFormReady.value = true;
  await nextTick();

  loginFormMedia = gsap.matchMedia();
  loginFormMedia.add(
    {
      allowMotion: "(prefers-reduced-motion: no-preference)",
      reduceMotion: "(prefers-reduced-motion: reduce)",
    },
    (context) => {
      const { reduceMotion } = context.conditions as { reduceMotion: boolean };
      if (reduceMotion) {
        gsap.set(formElement, { clearProps: "opacity,visibility" });
        return;
      }

      gsap.fromTo(
        formElement,
        { autoAlpha: 0 },
        {
          autoAlpha: 1,
          duration: 0.9,
          delay: 0.28,
          ease: "power2.out",
          clearProps: "opacity,visibility",
        },
      );
    },
    formElement,
  );
}

onMounted(async () => {
  if (desktop) {
    endpointState.value = await desktopState();
    endpoint.value = endpointState.value?.endpoint ?? endpointState.value?.recentEndpoint ?? "";
  }
  loadRememberedLogin();
  void revealLoginForm();
});

onBeforeUnmount(() => {
  environmentTitleMedia?.revert();
  loginFormMedia?.revert();
});
</script>

<template>
  <main class="login-page">
    <div v-if="desktop" class="desktop-window-drag-region" aria-hidden="true"></div>
    <ShapeGrid
      class="login-shape-grid"
      direction="diagonal"
      :speed="0.35"
      :square-size="72"
      :border-color="theme === 'bright' ? 'rgba(45, 93, 84, 0.18)' : 'rgba(80, 91, 111, 0.30)'"
      :hover-fill-color="theme === 'bright' ? 'rgba(33, 151, 128, 0.08)' : 'rgba(45, 192, 157, 0.10)'"
      :vignette-color="theme === 'bright' ? 'rgba(8, 8, 14, 0)' : 'rgba(8, 8, 14, 0.32)'"
      shape="square"
      :hover-trail-amount="2"
    />
    <section class="login-story" aria-labelledby="login-title">
      <div class="login-brand"><span class="login-brand__mark"><img :src="vironLogoUrl" alt="" /></span><span>VIRON / OPERATIONS</span></div>
      <div class="login-story__content">
        <div class="login-copy">
          <h1
            id="login-title"
            class="login-title"
            :aria-label="$t('把 Web、SSH、数据库，统一到一个 Environment。')"
          >
            <ShuffleText
              class="login-title__lead"
              tag="span"
              :text='$t("把 Web、SSH、数据库\n统一到一个")'
              direction="up"
              :duration="0.46"
              :stagger="0.024"
              :delay="0.08"
              :shuffle-times="2"
              :trigger-on-hover="false"
              :color-from="theme === 'bright' ? '#18806d' : '#56d6b2'"
              :color-to="theme === 'bright' ? '#26393e' : '#f3f8f6'"
              aria-hidden="true"
              @complete="revealEnvironmentTitle"
            />
            <span
              ref="environmentTitle"
              class="environment-title"
              :class="{ 'is-animation-ready': environmentTitleReady }"
              aria-hidden="true"
            >
              <span class="environment-title__word">
                <span class="environment-title__affix" data-environment-prefix>EN</span>
                <span class="environment-title__viron" aria-label="VIRON">
                  <span v-for="letter in 'VIRON'" :key="letter" class="environment-title__viron-letter">
                    {{ letter }}
                  </span>
                </span>
                <span class="environment-title__affix" data-environment-suffix>MENT</span>
              </span>
            </span>
          </h1>
        </div>
        <div
          ref="capabilityGrid"
          class="capability-grid"
          :class="{ 'is-animation-ready': capabilityGridReady }"
        >
          <article><Globe2 :size="20" /><strong>{{ $t('Web 入口') }}</strong><span>{{ $t('多账号视角 · 内置浏览') }}</span></article>
          <article><TerminalSquare :size="20" /><strong>{{ $t('SSH 终端') }}</strong><span>{{ $t('登录脚本 · 分屏会话') }}</span></article>
          <article><Database :size="20" /><strong>{{ $t('数据库') }}</strong><span>{{ $t('对象收藏 · 数据维护') }}</span></article>
        </div>
      </div>
    </section>

    <section class="login-panel">
      <form
        ref="loginFormElement"
        class="login-form"
        :class="{ 'is-animation-ready': loginFormReady }"
        @submit.prevent="submit"
      >
        <div class="login-form__icon"><ShieldCheck :size="28" /></div>
        <div>
          <h2>{{ registering ? $t('注册 Viron') : $t('登录 Viron') }}</h2>
        </div>

        <label v-if="desktop">
          <span>Viron Endpoint</span>
          <el-input v-model="endpoint" size="large" aria-label="Viron Endpoint" placeholder="https://viron.example.com" autocomplete="url">
            <template #prefix><Server :size="15" /></template>
          </el-input>
        </label>
        <label>
          <span>{{ $t('用户名') }}</span>
          <el-input v-model="form.username" size="large" :placeholder="$t('输入用户名')" autocomplete="username" />
        </label>
        <label>
          <span>{{ $t('密码') }}</span>
          <el-input
            v-model="form.password"
            size="large"
            type="password"
            show-password
            :placeholder="$t('输入密码')"
            :autocomplete="registering ? 'new-password' : 'current-password'"
            @keyup.enter="submit"
          />
        </label>
        <label v-if="registering">
          <span>{{ $t('确认密码') }}</span>
          <el-input v-model="form.confirmPassword" size="large" type="password" show-password :placeholder="$t('再次输入密码')" autocomplete="new-password" @keyup.enter="submit" />
        </label>
        <div v-if="!registering && !desktop" class="login-form__options">
          <el-checkbox v-model="rememberPassword" class="login-remember" @change="handleRememberChange"> {{ $t('记住密码') }} </el-checkbox>
        </div>
        <el-button native-type="submit" type="primary" size="large" :loading="loading">
          {{ registering ? $t('创建账号并进入') : $t('进入运维桌面') }}<ArrowRight :size="17" />
        </el-button>
        <el-button text type="primary" @click="toggleRegistering">{{ registering ? $t('已有账号，返回登录') : $t('没有账号？自主注册') }}</el-button>
      </form>
    </section>
  </main>
</template>
