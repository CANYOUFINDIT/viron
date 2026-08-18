<script setup lang="ts">import { translate as tr } from "../i18n";

import { Check, Download, Globe2, Laptop, PackageOpen, RefreshCw, ShieldCheck, Sparkles, X } from "@lucide/vue";
import { ElMessage } from "element-plus";
import { computed, onMounted, ref } from "vue";
import type { ClientInstallerCatalog, ClientInstallerInformation } from "../../shared/client-installer";
import { api } from "../api";
import {
  clientPlatformLabel,
  detectClientPlatform,
  recommendedClientInstaller,
  type ClientPlatformDetection,
} from "../client-platform-detection";
import PageHeader from "../components/PageHeader.vue";
import { downloadApiFile } from "../desktop";

const installers = ref<ClientInstallerInformation[]>([]);
const loading = ref(true);
const errorMessage = ref("");
const downloading = ref("");
const installerCatalog = ref<HTMLElement | null>(null);
const platformDetection = ref<ClientPlatformDetection | null>(null);

const recommendedInstaller = computed(() => recommendedClientInstaller(installers.value, platformDetection.value));
const detectionMessage = computed(() => {
  const detection = platformDetection.value;
  if (!detection) return tr("正在检测这台电脑");
  const label = clientPlatformLabel(detection);
  if (recommendedInstaller.value) return tr("检测到 {0}，已标记匹配版本", [label]);
  if (detection.platform) return tr("检测到 {0}，浏览器无法确认匹配架构，请手动选择", [label]);
  return tr("未检测到 macOS 或 Windows，请手动选择安装包");
});

function platformLabel(platform: ClientInstallerInformation["platform"]): string {
  return platform === "macos" ? "macOS" : "Windows";
}

function architectureLabel(installer: ClientInstallerInformation): string {
  if (installer.architecture === "arm64") return installer.platform === "macos" ? "Apple Silicon · arm64" : "ARM64";
  if (installer.architecture === "x64") return tr("Intel / AMD · 64 位");
  if (installer.architecture === "x86") return tr("Intel / AMD · 32 位");
  if (installer.architecture === "universal") return tr("通用架构");
  return tr("架构未标注");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

async function loadInstallers() {
  loading.value = true;
  errorMessage.value = "";
  try {
    installers.value = (await api<ClientInstallerCatalog>("/api/v1/client-installers")).items;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : tr("客户端安装包加载失败");
  } finally {
    loading.value = false;
  }
}

async function downloadInstaller(installer: ClientInstallerInformation) {
  if (downloading.value) return;
  downloading.value = installer.fileName;
  try {
    await downloadApiFile(installer.downloadUrl, installer.fileName);
    ElMessage.success(tr("已开始下载 {0}", [installer.fileName]));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("安装包下载失败"));
  } finally {
    downloading.value = "";
  }
}

function scrollToInstallers() {
  installerCatalog.value?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function isRecommendedInstaller(installer: ClientInstallerInformation): boolean {
  return installer.fileName === recommendedInstaller.value?.fileName;
}

onMounted(() => {
  void loadInstallers();
  void detectClientPlatform().then((detection) => { platformDetection.value = detection; });
});
</script>

<template>
  <div class="client-downloads-page">
    <PageHeader :title="$t('下载客户端')">
      <template #actions>
        <el-button :loading="loading" @click="loadInstallers">
          <RefreshCw v-if="!loading" :size="15" />{{ $t('刷新安装包') }} </el-button>
      </template>
    </PageHeader>

    <section class="client-comparison" aria-labelledby="client-comparison-title">
      <header class="section-heading">
        <span>{{ $t('Web 入口体验对比') }}</span>
        <h2 id="client-comparison-title">{{ $t('完整体验，推荐使用桌面客户端') }}</h2>
      </header>

      <div class="comparison-grid">
        <article class="comparison-card is-desktop">
          <span class="comparison-card__recommendation">{{ $t('最佳体验') }}</span>
          <header class="comparison-card__header">
            <span class="comparison-card__icon"><Laptop :size="22" /></span>
            <div>
              <h3>{{ $t('桌面客户端') }}</h3>
              <p>{{ $t('推荐用于日常 Web 运维') }}</p>
            </div>
          </header>

          <div class="comparison-card__mode">
            <small>{{ $t('WEB 入口体验') }}</small>
            <strong>{{ $t('原生 Chromium 直连') }}</strong>
            <span>{{ $t('目标页面直接运行在本机 Chromium 中，无需持续接收远程画面') }}</span>
          </div>

          <button class="comparison-card__action" type="button" @click="scrollToInstallers">
            <Download :size="16" />{{ $t('立即下载桌面客户端') }} </button>

          <ul class="comparison-card__features">
            <li><span class="is-positive"><Check :size="13" /></span><p><strong>{{ $t('原生页面加载') }}</strong><small>{{ $t('减少远程画面传输，页面滚动与交互响应更快') }}</small></p></li>
            <li><span class="is-positive"><Check :size="13" /></span><p><strong>{{ $t('完整检查元素能力') }}</strong><small>{{ $t('右键打开 Chromium DevTools，查看目标 DOM、网络与存储') }}</small></p></li>
            <li><span class="is-positive"><Check :size="13" /></span><p><strong>{{ $t('原生浏览器功能') }}</strong><small>{{ $t('系统文件选择、保存下载与独立账号 Profile') }}</small></p></li>
            <li><span class="is-positive"><Check :size="13" /></span><p><strong>{{ $t('本机网络直连') }}</strong><small>{{ $t('直接访问当前电脑可达的内网与本地目标') }}</small></p></li>
            <li><span class="is-positive"><Sparkles :size="13" /></span><p><strong>{{ $t('Viron Agent 技术预览') }}</strong><small>{{ $t('支持本机模型配置与流式聊天；SSH、数据库现场辅助待接入') }}</small></p></li>
          </ul>
        </article>

        <article class="comparison-card is-web">
          <header class="comparison-card__header">
            <span class="comparison-card__icon"><Globe2 :size="22" /></span>
            <div>
              <h3>{{ $t('普通 Web 端') }}</h3>
              <p>{{ $t('免安装，仅适合临时访问') }}</p>
            </div>
          </header>

          <div class="comparison-card__mode">
            <small>{{ $t('WEB 入口限制') }}</small>
            <strong>{{ $t('远程 Chromium 画面') }}</strong>
            <span>{{ $t('目标页面运行在服务端 Chromium 中，浏览器持续接收画面流') }}</span>
          </div>

          <div class="comparison-card__action is-current">
            <Globe2 :size="16" />{{ $t('当前 Web 端 · 功能受限') }} </div>

          <ul class="comparison-card__features">
            <li><span class="is-negative"><X :size="13" /></span><p><strong>{{ $t('依赖远程画面传输') }}</strong><small>{{ $t('服务端持续截图并通过网络传回，交互延迟更高') }}</small></p></li>
            <li><span class="is-negative"><X :size="13" /></span><p><strong>{{ $t('无法检查目标元素') }}</strong><small>{{ $t('浏览器 DevTools 只能看到 Viron 外壳，不能读取目标网站 DOM') }}</small></p></li>
            <li><span class="is-negative"><X :size="13" /></span><p><strong>{{ $t('文件操作需要中转') }}</strong><small>{{ $t('上传与下载需要经过中心服务和网络链路') }}</small></p></li>
            <li><span class="is-negative"><X :size="13" /></span><p><strong>{{ $t('受中心服务网络限制') }}</strong><small>{{ $t('只能访问中心服务所在网络能够连接的目标') }}</small></p></li>
            <li><span class="is-negative"><X :size="13" /></span><p><strong>{{ $t('不支持 Viron Agent') }}</strong><small>{{ $t('已确认的首期 Viron Agent 只面向桌面客户端') }}</small></p></li>
          </ul>
        </article>
      </div>
    </section>

    <section ref="installerCatalog" class="installer-catalog" aria-labelledby="installer-catalog-title">
      <header class="installer-catalog__header">
        <div class="section-heading is-compact">
          <span>{{ $t('安装包') }}</span>
          <h2 id="installer-catalog-title">{{ $t('选择适合这台电脑的版本') }}</h2>
        </div>
        <span
          class="installer-detection"
          :class="{
            'is-match': Boolean(recommendedInstaller),
            'is-platform-only': platformDetection?.confidence === 'platform',
          }"
        >
          <Laptop :size="14" />{{ detectionMessage }}
        </span>
      </header>

      <section v-if="loading" class="installer-grid" :aria-label="$t('正在加载客户端安装包')" aria-busy="true">
        <article v-for="index in 2" :key="index" class="installer-card installer-card--skeleton">
          <span></span><i></i><i></i><button disabled></button>
        </article>
      </section>

      <section v-else-if="errorMessage" class="downloads-state is-error">
        <PackageOpen :size="30" />
        <strong>{{ $t('安装包加载失败') }}</strong>
        <span>{{ errorMessage }}</span>
        <el-button @click="loadInstallers">{{ $t('重新加载') }}</el-button>
      </section>

      <section v-else-if="installers.length" class="installer-grid" :aria-label="$t('可下载客户端')">
        <article
          v-for="(installer, index) in installers"
          :key="installer.fileName"
          class="installer-card"
          :class="[`is-${installer.platform}`, { 'is-recommended': isRecommendedInstaller(installer) }]"
          :style="{ '--card-index': index }"
        >
          <div
            v-if="isRecommendedInstaller(installer)"
            class="installer-card__recommendation-banner"
            :aria-label="$t('推荐下载，最适合当前电脑')"
          >
            <span><Sparkles :size="14" /><strong>{{ $t('推荐下载') }}</strong></span>
            <small>{{ $t('最适合当前电脑') }}</small>
          </div>

          <div class="installer-card__topline">
            <span>{{ installer.fileName.toLowerCase().endsWith('.dmg') ? 'DMG' : 'EXE' }}</span>
            <span v-if="isRecommendedInstaller(installer)" class="installer-card__recommended"><Check :size="11" />{{ $t('系统与架构匹配') }}</span>
            <span v-else class="installer-card__available"><i></i>{{ $t('可下载') }}</span>
          </div>

          <div class="installer-card__platform" aria-hidden="true">
            <svg v-if="installer.platform === 'macos'" class="apple-mark" viewBox="0 0 24 24">
              <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
            </svg>
            <span v-else class="windows-mark"><i></i><i></i><i></i><i></i></span>
          </div>

          <div class="installer-card__copy">
            <span>{{ platformLabel(installer.platform) }} {{ $t('客户端') }}</span>
            <strong>{{ installer.version ? `V${installer.version}` : $t('当前版本') }}</strong>
            <small>{{ architectureLabel(installer) }}</small>
          </div>

          <div class="installer-card__meta">
            <span>{{ formatSize(installer.size) }}</span>
            <span :title="installer.fileName">{{ installer.fileName }}</span>
          </div>

          <button
            class="installer-card__download"
            type="button"
            :disabled="Boolean(downloading)"
            :aria-label="$t('下载 {0} {1} 客户端', [platformLabel(installer.platform), architectureLabel(installer)])"
            @click="downloadInstaller(installer)"
          >
            <RefreshCw v-if="downloading === installer.fileName" class="is-spinning" :size="16" />
            <Download v-else :size="16" />
            {{ downloading === installer.fileName ? $t('正在下载') : $t('下载客户端') }}
          </button>
        </article>
      </section>

      <section v-else class="downloads-state">
        <PackageOpen :size="32" />
        <strong>{{ $t('暂无可下载客户端') }}</strong>
      </section>
    </section>

    <footer class="downloads-note">
      <ShieldCheck :size="16" />
      <span>{{ $t('安装包由当前 Viron 服务直接提供。安装前请确认文件名、系统架构与服务来源。') }}</span>
    </footer>
  </div>
</template>

<style scoped>
.client-downloads-page { min-height: calc(100vh - 60px); }
.section-heading { margin-bottom: 14px; }
.section-heading > span { color: var(--teal-700); font-size: 9px; font-weight: 850; letter-spacing: .12em; text-transform: uppercase; }
.section-heading h2 { margin: 5px 0 0; color: var(--ink-900); font-family: var(--font-display); font-size: 20px; line-height: 1.2; letter-spacing: -.02em; }
.section-heading.is-compact { margin-bottom: 0; }
.comparison-grid { display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(0, .92fr); gap: 14px; }
.comparison-card { --comparison-accent: var(--ink-500); position: relative; min-width: 0; padding: 21px; border: 1px solid var(--ink-200); border-radius: 14px; background: linear-gradient(155deg, var(--surface) 0 74%, color-mix(in srgb, var(--comparison-accent) 5%, var(--surface))); overflow: hidden; box-shadow: 0 12px 30px color-mix(in srgb, var(--ink-900) 5%, transparent); }
.comparison-card::before { content: ""; position: absolute; inset: 0 0 auto; height: 3px; background: var(--comparison-accent); opacity: .82; }
.comparison-card.is-desktop { --comparison-accent: var(--teal-600); border-color: color-mix(in srgb, var(--teal-500) 48%, var(--ink-200)); background: linear-gradient(150deg, var(--surface) 0 66%, color-mix(in srgb, var(--teal-100) 40%, var(--surface))); box-shadow: 0 18px 42px color-mix(in srgb, var(--teal-700) 13%, transparent); }
.comparison-card.is-web { --comparison-accent: var(--ink-400); background: linear-gradient(155deg, color-mix(in srgb, var(--ink-50) 58%, var(--surface)) 0 74%, color-mix(in srgb, var(--ink-200) 18%, var(--surface))); }
.comparison-card__recommendation { position: absolute; top: 0; right: 19px; padding: 5px 11px 6px; border-radius: 0 0 7px 7px; background: var(--teal-600); color: #fff; font-size: 9px; font-weight: 850; letter-spacing: .08em; }
.comparison-card__header { display: flex; align-items: center; gap: 11px; }
.comparison-card__icon { width: 40px; height: 40px; border: 1px solid color-mix(in srgb, var(--comparison-accent) 22%, var(--ink-200)); border-radius: 11px; background: color-mix(in srgb, var(--comparison-accent) 8%, var(--surface)); color: var(--comparison-accent); display: grid; place-items: center; }
.comparison-card__header h3 { margin: 0; color: var(--ink-900); font-family: var(--font-display); font-size: 17px; letter-spacing: -.015em; }
.comparison-card__header p { margin: 3px 0 0; color: var(--ink-400); font-size: 10px; }
.comparison-card__mode { margin-top: 19px; min-height: 95px; padding: 14px 15px; border: 1px solid color-mix(in srgb, var(--comparison-accent) 13%, var(--ink-100)); border-radius: 10px; background: color-mix(in srgb, var(--comparison-accent) 4%, var(--surface)); display: flex; flex-direction: column; align-items: flex-start; }
.comparison-card__mode small { color: var(--ink-400); font-size: 9px; font-weight: 760; }
.comparison-card__mode strong { margin-top: 3px; color: var(--ink-900); font-family: var(--font-display); font-size: 22px; line-height: 1.2; letter-spacing: -.025em; }
.comparison-card__mode span { margin-top: 5px; color: var(--ink-500); font-size: 10px; line-height: 1.5; }
.comparison-card__action { width: 100%; min-height: 38px; margin-top: 13px; border: 1px solid var(--comparison-accent); border-radius: 8px; background: var(--comparison-accent); color: #fff; display: inline-flex; align-items: center; justify-content: center; gap: 7px; font-family: inherit; font-size: 11px; font-weight: 800; }
button.comparison-card__action { cursor: pointer; transition: transform .16s ease, box-shadow .16s ease, background-color .16s ease; }
button.comparison-card__action:hover { transform: translateY(-1px); box-shadow: 0 8px 18px color-mix(in srgb, var(--comparison-accent) 22%, transparent); }
.comparison-card__action.is-current { border-color: var(--ink-200); background: transparent; color: var(--ink-500); }
.comparison-card__features { margin: 16px 0 0; padding: 15px 0 0; border-top: 1px solid var(--ink-100); display: grid; gap: 10px; list-style: none; }
.comparison-card__features li { min-width: 0; color: var(--ink-600); display: flex; align-items: flex-start; gap: 8px; }
.comparison-card__features li > span { width: 18px; height: 18px; flex: 0 0 auto; border-radius: 50%; display: grid; place-items: center; }
.comparison-card__features li > span.is-positive { background: color-mix(in srgb, #2d9b74 12%, transparent); color: #278965; }
.comparison-card__features li > span.is-negative { background: color-mix(in srgb, var(--ink-500) 9%, transparent); color: var(--ink-400); }
.comparison-card__features p { min-width: 0; margin: 0; display: flex; flex-direction: column; gap: 2px; line-height: 1.45; }
.comparison-card__features p strong { color: var(--ink-700); font-size: 10px; }
.comparison-card__features p small { color: var(--ink-400); font-size: 9px; line-height: 1.5; }
.comparison-card.is-web .comparison-card__features li > span.is-negative { background: color-mix(in srgb, #c5574d 10%, transparent); color: #b8554c; }
.installer-catalog { margin-top: 30px; scroll-margin-top: 18px; }
.installer-catalog__header { min-width: 0; display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
.installer-detection { max-width: 480px; min-height: 29px; padding: 5px 9px; border: 1px solid var(--ink-200); border-radius: 7px; background: color-mix(in srgb, var(--ink-50) 70%, var(--surface)); color: var(--ink-500); display: inline-flex; align-items: center; gap: 6px; font-size: 9px; line-height: 1.5; }
.installer-detection svg { flex: 0 0 auto; }
.installer-detection.is-match { border-color: color-mix(in srgb, var(--teal-500) 28%, var(--ink-200)); background: color-mix(in srgb, var(--teal-50) 72%, var(--surface)); color: var(--teal-700); }
.installer-detection.is-platform-only { border-color: color-mix(in srgb, var(--amber-600) 24%, var(--ink-200)); background: color-mix(in srgb, var(--amber-100) 46%, var(--surface)); color: color-mix(in srgb, var(--amber-600) 84%, var(--ink-700)); }
.installer-grid { margin-top: 18px; display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 14px; }
.installer-card { --platform-accent: #1787c9; position: relative; min-width: 0; min-height: 368px; padding: 18px; border: 1px solid var(--ink-200); border-radius: 13px; background: linear-gradient(160deg, var(--surface) 0 68%, color-mix(in srgb, var(--platform-accent) 5%, var(--surface))); display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 12px 30px color-mix(in srgb, var(--ink-900) 5%, transparent); animation: installer-card-in .38s cubic-bezier(.22, 1, .36, 1) both; animation-delay: calc(var(--card-index) * 55ms); }
.installer-card::before { content: ""; position: absolute; inset: 0 0 auto; height: 3px; background: var(--platform-accent); opacity: .8; }
.installer-card.is-macos { --platform-accent: #56616a; }
.installer-card.is-recommended { padding-top: 54px; border: 2px solid var(--teal-600); background: linear-gradient(150deg, color-mix(in srgb, var(--teal-50) 84%, var(--surface)) 0%, var(--surface) 56%, color-mix(in srgb, var(--teal-100) 58%, var(--surface)) 100%); box-shadow: 0 22px 46px color-mix(in srgb, var(--teal-700) 22%, transparent), 0 0 0 4px color-mix(in srgb, var(--teal-500) 9%, transparent); }
.installer-card.is-recommended::before { display: none; }
.installer-card__recommendation-banner { position: absolute; inset: 0 0 auto; height: 38px; padding: 0 15px; border-radius: 10px 10px 0 0; background: linear-gradient(105deg, var(--teal-700), var(--teal-600)); color: #fff; display: flex; align-items: center; justify-content: space-between; gap: 10px; box-shadow: 0 6px 16px color-mix(in srgb, var(--teal-700) 22%, transparent); }
.installer-card__recommendation-banner > span { display: inline-flex; align-items: center; gap: 6px; }
.installer-card__recommendation-banner svg { flex: 0 0 auto; }
.installer-card__recommendation-banner strong { font-size: 11px; letter-spacing: .04em; }
.installer-card__recommendation-banner small { color: color-mix(in srgb, #fff 82%, var(--teal-100)); font-size: 9px; font-weight: 700; white-space: nowrap; }
.installer-card__topline { display: flex; align-items: center; justify-content: space-between; color: var(--ink-400); font-size: 9px; font-weight: 800; letter-spacing: .1em; }
.installer-card__available { display: inline-flex; align-items: center; gap: 5px; letter-spacing: 0; }
.installer-card__available i { width: 6px; height: 6px; border-radius: 50%; background: #38aa81; box-shadow: 0 0 0 4px color-mix(in srgb, #38aa81 11%, transparent); }
.installer-card__recommended { padding: 4px 7px; border: 1px solid color-mix(in srgb, var(--teal-500) 24%, var(--ink-200)); border-radius: 999px; background: color-mix(in srgb, var(--teal-50) 82%, var(--surface)); color: var(--teal-700); display: inline-flex; align-items: center; gap: 4px; letter-spacing: 0; }
.installer-card__platform { width: 90px; height: 90px; margin: 30px auto 21px; border: 1px solid color-mix(in srgb, var(--platform-accent) 16%, var(--ink-200)); border-radius: 25px; background: color-mix(in srgb, var(--platform-accent) 7%, var(--surface)); color: var(--platform-accent); display: grid; place-items: center; transform: rotate(-2deg); transition: transform .22s ease, box-shadow .22s ease; }
.installer-card.is-recommended .installer-card__platform { margin-top: 20px; border-color: color-mix(in srgb, var(--teal-500) 24%, var(--ink-200)); background: color-mix(in srgb, var(--teal-50) 62%, var(--surface)); }
.installer-card:hover .installer-card__platform { transform: rotate(0) translateY(-3px); box-shadow: 0 12px 24px color-mix(in srgb, var(--platform-accent) 13%, transparent); }
.apple-mark { width: 48px; height: 48px; fill: currentColor; }
.windows-mark { width: 47px; height: 47px; display: grid; grid-template-columns: 1fr 1fr; gap: 3px; transform: perspective(80px) rotateY(-5deg); }
.windows-mark i { background: currentColor; }
.installer-card__copy { display: flex; flex-direction: column; align-items: center; text-align: center; }
.installer-card__copy > span { color: var(--ink-500); font-size: 11px; font-weight: 750; }
.installer-card.is-recommended .installer-card__copy > span { color: var(--teal-700); }
.installer-card__copy strong { margin-top: 5px; color: var(--ink-900); font-family: var(--font-display); font-size: 23px; letter-spacing: -.03em; }
.installer-card__copy small { margin-top: 4px; color: var(--ink-400); font-size: 10px; }
.installer-card__meta { min-width: 0; margin: 18px 0 13px; padding-top: 12px; border-top: 1px solid var(--ink-100); display: flex; justify-content: space-between; gap: 12px; color: var(--ink-400); font-size: 9px; }
.installer-card__meta span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.installer-card__download { width: 100%; height: 38px; margin-top: auto; border: 1px solid color-mix(in srgb, var(--platform-accent) 40%, var(--ink-200)); border-radius: 8px; background: color-mix(in srgb, var(--platform-accent) 9%, var(--surface)); color: color-mix(in srgb, var(--platform-accent) 86%, var(--ink-900)); display: inline-flex; align-items: center; justify-content: center; gap: 7px; cursor: pointer; font-family: inherit; font-size: 12px; font-weight: 800; transition: background-color .16s ease, color .16s ease, transform .16s ease, box-shadow .16s ease; }
.installer-card__download:hover:not(:disabled) { background: var(--platform-accent); color: #fff; transform: translateY(-1px); box-shadow: 0 8px 18px color-mix(in srgb, var(--platform-accent) 20%, transparent); }
.installer-card.is-recommended .installer-card__download { border-color: var(--teal-700); background: var(--teal-700); color: #fff; box-shadow: 0 8px 18px color-mix(in srgb, var(--teal-700) 22%, transparent); }
.installer-card.is-recommended .installer-card__download:hover:not(:disabled) { background: var(--teal-700); box-shadow: 0 8px 18px color-mix(in srgb, var(--teal-700) 24%, transparent); }
.installer-card__download:disabled { cursor: wait; opacity: .58; }
.downloads-state { min-height: 310px; margin-top: 18px; padding: 30px; border: 1px dashed var(--ink-300); border-radius: 13px; background: color-mix(in srgb, var(--ink-50) 48%, var(--surface)); color: var(--ink-400); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; }
.downloads-state strong { color: var(--ink-700); font-size: 14px; }
.downloads-state span { max-width: 520px; font-size: 11px; line-height: 1.6; }
.downloads-state.is-error { color: #b4534d; }
.downloads-state .el-button { margin-top: 5px; }
.downloads-note { margin-top: 16px; padding: 11px 14px; border-radius: 8px; background: color-mix(in srgb, var(--teal-50) 58%, transparent); color: var(--ink-500); display: flex; align-items: center; gap: 8px; font-size: 10px; }
.downloads-note svg { flex: 0 0 auto; color: var(--teal-600); }
.installer-card--skeleton { animation: none; }
.installer-card--skeleton > span { width: 58px; height: 12px; border-radius: 5px; background: var(--ink-100); }
.installer-card--skeleton > i { display: block; margin-inline: auto; border-radius: 18px; background: var(--ink-100); animation: skeleton-pulse 1.2s ease-in-out infinite alternate; }
.installer-card--skeleton > i:nth-of-type(1) { width: 90px; height: 90px; margin-top: 42px; }
.installer-card--skeleton > i:nth-of-type(2) { width: 120px; height: 44px; margin-top: 20px; }
.installer-card--skeleton > button { height: 38px; margin-top: auto; border: 0; border-radius: 8px; background: var(--ink-100); }
.is-spinning { animation: installer-spin .9s linear infinite; }
@keyframes installer-card-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
@keyframes installer-spin { to { transform: rotate(360deg); } }
@keyframes skeleton-pulse { to { opacity: .45; } }
@media (max-width: 760px) {
  .comparison-grid { grid-template-columns: 1fr; }
  .comparison-card { padding: 19px; }
  .installer-catalog__header { align-items: flex-start; flex-direction: column; gap: 9px; }
  .installer-detection { max-width: 100%; }
  .installer-grid { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  .installer-card, .installer-card--skeleton > i { animation: none; }
}
</style>
