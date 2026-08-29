<script setup lang="ts">import { translate as tr } from "../i18n";

import { Copy, Download, Fingerprint, KeyRound, LockKeyhole, Pencil, Plus, RefreshCw, Search, ShieldCheck, Trash2, Upload } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { copyTextToClipboard } from "../clipboard";
import PageHeader from "../components/PageHeader.vue";
import CertificateCenter from "../components/credentials/CertificateCenter.vue";
import { downloadApiFile } from "../desktop";
import { session } from "../session";

interface SshKeyItem {
  id: string;
  name: string;
  algorithm: string;
  publicKey: string;
  fingerprint: string;
  connectionCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const route = useRoute();
const router = useRouter();
const certificateCenter = ref<{ openCreate: () => void; probeAll: () => Promise<void>; batchBusy: boolean; certificateCount: number } | null>(null);
const activeTab = computed(() => route.query.tab === "ssl" ? "ssl" : "ssh");
const loading = ref(true);
const saving = ref(false);
const keys = ref<SshKeyItem[]>([]);
const importDialog = ref(false);
const generateDialog = ref(false);
const renameDialog = ref(false);
const editingKey = ref<SshKeyItem | null>(null);
const keyFileInput = ref<HTMLInputElement | null>(null);
const importForm = reactive({ name: "", privateKey: "", passphrase: "", filename: "" });
const generateForm = reactive({ name: "", algorithm: "ed25519" as "ed25519" | "rsa3072" | "rsa4096", passphrase: "" });
const renameForm = reactive({ name: "" });

const totalBindings = computed(() => keys.value.reduce((sum, key) => sum + key.connectionCount, 0));
const workspaceLabel = computed(() => session.workspace?.type === "organization" ? session.workspace.name : tr("个人空间"));

function algorithmLabel(value: string): string {
  if (value === "ssh-ed25519") return "ED25519";
  if (value === "ssh-rsa") return "RSA";
  return value;
}

async function load() {
  loading.value = true;
  try {
    keys.value = (await api<{ items: SshKeyItem[] }>("/api/v1/ssh-keys")).items;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载 SSH 密钥失败"));
  } finally {
    loading.value = false;
  }
}

function openImport() {
  Object.assign(importForm, { name: "", privateKey: "", passphrase: "", filename: "" });
  if (keyFileInput.value) keyFileInput.value.value = "";
  importDialog.value = true;
}

function openGenerate() {
  Object.assign(generateForm, { name: "", algorithm: "ed25519", passphrase: "" });
  generateDialog.value = true;
}

async function selectKeyFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 128 * 1024) {
    (event.target as HTMLInputElement).value = "";
    return ElMessage.warning(tr("私钥文件不能超过 128 KiB"));
  }
  importForm.privateKey = await file.text();
  importForm.filename = file.name;
  if (!importForm.name) importForm.name = file.name.replace(/\.(pem|key|ppk)$/i, "");
}

async function saveImport() {
  if (!importForm.name.trim() || !importForm.privateKey.trim()) return ElMessage.warning(tr("请填写密钥名称并选择或粘贴私钥"));
  saving.value = true;
  try {
    await api("/api/v1/ssh-keys/import", { method: "POST", body: JSON.stringify(importForm) });
    importDialog.value = false;
    ElMessage.success(tr("SSH 密钥已导入"));
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("导入 SSH 密钥失败"));
  } finally {
    saving.value = false;
  }
}

async function generateKey() {
  if (!generateForm.name.trim()) return ElMessage.warning(tr("请填写密钥名称"));
  saving.value = true;
  try {
    await api("/api/v1/ssh-keys/generate", { method: "POST", body: JSON.stringify(generateForm) });
    generateDialog.value = false;
    ElMessage.success(tr("SSH 密钥已生成，请导出公钥并部署到目标服务器"));
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("生成 SSH 密钥失败"));
  } finally {
    saving.value = false;
  }
}

function openRename(key: SshKeyItem) {
  editingKey.value = key;
  renameForm.name = key.name;
  renameDialog.value = true;
}

async function renameKey() {
  if (!editingKey.value || !renameForm.name.trim()) return ElMessage.warning(tr("请填写密钥名称"));
  saving.value = true;
  try {
    await api(`/api/v1/ssh-keys/${editingKey.value.id}`, { method: "PUT", body: JSON.stringify(renameForm) });
    renameDialog.value = false;
    ElMessage.success(tr("密钥名称已更新"));
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("更新 SSH 密钥失败"));
  } finally {
    saving.value = false;
  }
}

async function copyPublicKey(key: SshKeyItem) {
  try {
    await copyTextToClipboard(key.publicKey);
    ElMessage.success(tr("公钥已复制"));
  } catch {
    ElMessage.error(tr("无法访问剪贴板，请导出公钥文件"));
  }
}

async function exportKey(key: SshKeyItem, part: "public" | "private") {
  if (part === "private") {
    try {
      await ElMessageBox.confirm(
        tr("即将导出“{0}”的私钥文件。获得该文件的人可能登录所有信任此密钥的服务器。", [key.name]),
        tr("导出私钥"),
        { confirmButtonText: tr("确认导出"), cancelButtonText: tr("取消"), type: "warning" },
      );
    } catch (error) {
      if (error === "cancel" || error === "close") return;
      throw error;
    }
  }
  try {
    await downloadApiFile(`/api/v1/ssh-keys/${key.id}/export?part=${part}`, part === "public" ? `${key.name}.pub` : key.name);
    ElMessage.success(part === "public" ? tr("公钥导出已开始") : tr("私钥导出已开始"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("导出 SSH 密钥失败"));
  }
}

async function removeKey(key: SshKeyItem) {
  if (key.connectionCount) return ElMessage.warning(tr("该密钥仍被 {0} 条 SSH 连接使用", [key.connectionCount]));
  try {
    await ElMessageBox.confirm(tr("删除密钥“{0}”？删除后无法恢复。", [key.name]), tr("删除 SSH 密钥"), { confirmButtonText: tr("删除"), cancelButtonText: tr("取消"), type: "warning" });
    await api(`/api/v1/ssh-keys/${key.id}`, { method: "DELETE" });
    ElMessage.success(tr("SSH 密钥已删除"));
    await load();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("删除 SSH 密钥失败"));
  }
}

function selectTab(tab: "ssh" | "ssl") {
  void router.replace({ query: { ...route.query, tab } });
}

watch(activeTab, (tab) => {
  if (tab === "ssh") void load();
});

onMounted(load);
</script>

<template>
  <div class="ssh-key-vault" v-loading="loading && activeTab === 'ssh'">
    <PageHeader :title="$t('密钥与证书')">
      <template #actions>
        <template v-if="activeTab === 'ssh'">
          <el-button @click="openImport"><Upload :size="16" />{{ $t('导入密钥') }}</el-button>
          <el-button type="primary" @click="openGenerate"><Plus :size="16" />{{ $t('生成密钥') }}</el-button>
        </template>
        <template v-else>
          <el-button @click="certificateCenter?.openCreate()"><Search :size="16" />{{ $t('手动录入端点探测') }}</el-button>
          <el-button type="primary" :loading="certificateCenter?.batchBusy" :disabled="certificateCenter?.batchBusy" @click="certificateCenter?.probeAll()"><RefreshCw :size="16" />{{ $t('全局批量重新探测') }}</el-button>
        </template>
      </template>
    </PageHeader>
    <p class="vault-subtitle">{{ $t('集中管理工作空间内的 SSH 连接私钥与 SSL/TLS 域名证书资产') }}</p>
    <nav class="vault-tabs" role="tablist">
      <button type="button" role="tab" :aria-selected="activeTab === 'ssh'" :class="{ 'is-active': activeTab === 'ssh' }" @click="selectTab('ssh')">{{ $t('SSH 密钥') }} ({{ keys.length }})</button>
      <button type="button" role="tab" :aria-selected="activeTab === 'ssl'" :class="{ 'is-active': activeTab === 'ssl' }" @click="selectTab('ssl')">{{ $t('SSL/TLS 证书') }} ({{ certificateCenter?.certificateCount ?? 0 }})</button>
    </nav>
    <CertificateCenter v-show="activeTab === 'ssl'" ref="certificateCenter" />
    <div v-show="activeTab === 'ssh'">

    <section class="vault-overview" :aria-label="$t('密钥概览')">
      <div class="vault-overview__copy">
        <span><ShieldCheck :size="15" />{{ workspaceLabel }} {{ $t('· 加密保管') }}</span>
        <h2>{{ $t('把连接凭据与服务器地址分开维护') }}</h2>
        <p>{{ $t('一把密钥可以关联多条 SSH 连接。私钥仅在建立连接或管理员明确导出时解密。') }}</p>
      </div>
      <div class="vault-metrics">
        <article><KeyRound :size="18" /><strong>{{ keys.length }}</strong><span>{{ $t('托管密钥') }}</span></article>
        <article><Fingerprint :size="18" /><strong>{{ totalBindings }}</strong><span>{{ $t('连接引用') }}</span></article>
        <article><LockKeyhole :size="18" /><strong>AES-GCM</strong><span>{{ $t('静态加密') }}</span></article>
      </div>
    </section>

    <section v-if="keys.length" class="vault-list">
      <article v-for="key in keys" :key="key.id" class="vault-key-card">
        <div class="vault-key-card__mark"><KeyRound :size="20" /></div>
        <div class="vault-key-card__identity">
          <header><h3>{{ key.name }}</h3><span>{{ algorithmLabel(key.algorithm) }}</span></header>
          <code>{{ key.fingerprint }}</code>
          <p>{{ $t('由') }} {{ key.createdBy || $t('当前管理员') }} {{ $t('维护 ·') }} {{ key.connectionCount }} {{ $t('条连接正在使用') }}</p>
        </div>
        <div class="vault-key-card__actions">
          <el-button text @click="copyPublicKey(key)"><Copy :size="15" />{{ $t('复制公钥') }}</el-button>
          <el-dropdown trigger="click">
            <el-button><Download :size="15" />{{ $t('导出') }}<small>⌄</small></el-button>
            <template #dropdown><el-dropdown-menu><el-dropdown-item @click="exportKey(key, 'public')">{{ $t('导出公钥文件') }}</el-dropdown-item><el-dropdown-item divided @click="exportKey(key, 'private')">{{ $t('导出私钥文件') }}</el-dropdown-item></el-dropdown-menu></template>
          </el-dropdown>
          <el-button text :aria-label="$t('重命名密钥')" :title="$t('重命名')" @click="openRename(key)"><Pencil :size="15" /></el-button>
          <el-button text class="is-danger" :aria-label="$t('删除密钥')" :title="$t('删除')" :disabled="key.connectionCount > 0" @click="removeKey(key)"><Trash2 :size="15" /></el-button>
        </div>
      </article>
    </section>

    <button v-else-if="!loading" class="vault-empty" type="button" @click="openImport">
      <span><KeyRound :size="28" /></span>
      <h3>{{ $t('当前空间还没有 SSH 密钥') }}</h3>
      <p>{{ $t('导入已有 OpenSSH 私钥，或生成一组新的密钥对。') }}</p>
      <em><Upload :size="15" />{{ $t('导入第一把密钥') }}</em>
    </button>

    <el-dialog v-model="importDialog" align-center class="envman-dialog" :title="$t('导入外部 SSH 密钥')" width="680px">
      <el-form label-position="top" class="vault-form">
        <el-form-item :label="$t('密钥名称')" required><el-input v-model="importForm.name" maxlength="160" :placeholder="$t('例如 bastion-01 id_rsa')" /></el-form-item>
        <el-form-item :label="$t('私钥口令')"><el-input v-model="importForm.passphrase" type="password" show-password :placeholder="$t('私钥未加密时留空')" /></el-form-item>
        <el-form-item :label="$t('私钥文件')" class="form-span-2">
          <label class="key-file-picker"><input ref="keyFileInput" type="file" accept=".pem,.key,.ppk,id_rsa,id_ed25519,text/plain" @change="selectKeyFile"><Upload :size="17" /><span><strong>{{ importForm.filename || $t('选择私钥文件') }}</strong><small>{{ $t('OpenSSH、PEM、PKCS#1 或 PKCS#8，最大 128 KiB') }}</small></span></label>
        </el-form-item>
        <el-form-item :label="$t('私钥内容')" class="form-span-2 form-item--code"><el-input v-model="importForm.privateKey" type="textarea" :rows="8" :placeholder="$t('也可以直接粘贴完整私钥内容')" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="importDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="saveImport">{{ $t('导入密钥') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="generateDialog" align-center class="envman-dialog" :title="$t('生成 SSH 密钥')" width="560px">
      <el-form label-position="top" class="vault-form">
        <el-form-item :label="$t('密钥名称')" required><el-input v-model="generateForm.name" maxlength="160" :placeholder="$t('例如 生产环境发布密钥')" /></el-form-item>
        <el-form-item :label="$t('密钥算法')"><el-select v-model="generateForm.algorithm" style="width:100%"><el-option :label="$t('ED25519（推荐）')" value="ed25519" /><el-option label="RSA 3072" value="rsa3072" /><el-option label="RSA 4096" value="rsa4096" /></el-select></el-form-item>
        <el-form-item :label="$t('私钥口令')" class="form-span-2"><el-input v-model="generateForm.passphrase" type="password" show-password :placeholder="$t('可选；设置后导出的私钥同样受口令保护')" /></el-form-item>
      </el-form>
      <div class="vault-dialog-note"><ShieldCheck :size="17" /><span>{{ $t('生成完成后请导出公钥，并部署到目标服务器的') }} <code>authorized_keys</code>。</span></div>
      <template #footer><el-button @click="generateDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="generateKey">{{ $t('生成密钥') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="renameDialog" align-center class="envman-dialog compact-dialog" :title="$t('重命名 SSH 密钥')" width="440px">
      <el-form label-position="top"><el-form-item :label="$t('密钥名称')" required><el-input v-model="renameForm.name" maxlength="160" @keyup.enter="renameKey" /></el-form-item></el-form>
      <template #footer><el-button @click="renameDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="renameKey">{{ $t('保存') }}</el-button></template>
    </el-dialog>
    </div>
  </div>
</template>

<style scoped>
.ssh-key-vault { min-width: 0; }
.vault-subtitle { margin: -8px 0 14px; color: var(--ink-500); font-size: 13px; }
.vault-tabs { display: flex; gap: 6px; margin-bottom: 16px; }
.vault-tabs button { padding: 7px 14px; border: 0; border-radius: 8px; background: var(--ink-100); color: var(--ink-600); font-size: 12px; font-weight: 800; cursor: pointer; }
.vault-tabs button.is-active { background: var(--surface); color: var(--teal-700); box-shadow: 0 2px 8px rgba(0,0,0,.06); }
.vault-overview { position: relative; min-height: 172px; padding: 25px 27px; border: 1px solid color-mix(in srgb, var(--teal-200) 66%, var(--ink-100)); border-radius: 15px; background: linear-gradient(115deg, color-mix(in srgb, var(--teal-50) 88%, var(--surface)) 0 54%, color-mix(in srgb, var(--surface) 92%, var(--ink-50)) 54%); box-shadow: var(--shadow-sm); display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(360px, .85fr); align-items: center; gap: 28px; overflow: hidden; }
.vault-overview::after { content: ""; position: absolute; right: 34%; bottom: -92px; width: 220px; height: 220px; border: 1px solid color-mix(in srgb, var(--teal-300) 34%, transparent); border-radius: 50%; pointer-events: none; }
.vault-overview__copy { position: relative; z-index: 1; min-width: 0; }
.vault-overview__copy > span { color: var(--teal-700); display: flex; align-items: center; gap: 7px; font-family: var(--font-mono); font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.vault-overview__copy h2 { margin: 15px 0 7px; color: var(--ink-900); font-family: var(--font-display); font-size: clamp(20px, 2vw, 29px); line-height: 1.15; }
.vault-overview__copy p { max-width: 650px; margin: 0; color: var(--ink-500); font-size: 13px; line-height: 1.7; }
.vault-metrics { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid color-mix(in srgb, var(--ink-100) 82%, transparent); border-radius: 12px; background: color-mix(in srgb, var(--surface) 90%, transparent); box-shadow: 0 12px 26px rgba(10, 38, 34, .07); backdrop-filter: blur(12px); overflow: hidden; }
.vault-metrics article { min-width: 0; padding: 18px 14px; display: grid; gap: 5px; }
.vault-metrics article + article { border-left: 1px solid var(--ink-100); }
.vault-metrics svg { color: var(--teal-600); }
.vault-metrics strong { margin-top: 4px; color: var(--ink-900); font-family: var(--font-display); font-size: 20px; overflow: hidden; text-overflow: ellipsis; }
.vault-metrics span { color: var(--ink-500); font-size: 10px; font-weight: 700; }
.vault-list { margin-top: 18px; display: grid; gap: 10px; }
.vault-key-card { min-width: 0; padding: 17px 18px; border: 1px solid var(--ink-100); border-radius: 11px; background: color-mix(in srgb, var(--surface) 96%, transparent); box-shadow: 0 5px 16px rgba(9, 32, 29, .045); display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; align-items: center; gap: 15px; transition: border-color .18s ease, transform .18s ease, box-shadow .18s ease; }
.vault-key-card:hover { border-color: color-mix(in srgb, var(--teal-400) 48%, var(--ink-100)); box-shadow: 0 10px 24px rgba(9, 42, 36, .08); transform: translateY(-1px); }
.vault-key-card__mark { width: 44px; height: 44px; border: 1px solid color-mix(in srgb, var(--teal-200) 70%, transparent); border-radius: 11px; background: var(--teal-50); color: var(--teal-700); display: grid; place-items: center; }
.vault-key-card__identity { min-width: 0; }
.vault-key-card__identity header { display: flex; align-items: center; gap: 9px; }
.vault-key-card__identity h3 { min-width: 0; margin: 0; color: var(--ink-900); font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vault-key-card__identity header span { padding: 3px 7px; border-radius: 4px; background: var(--ink-50); color: var(--ink-500); font-family: var(--font-mono); font-size: 9px; font-weight: 800; }
.vault-key-card__identity code { display: block; margin-top: 7px; color: var(--teal-700); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vault-key-card__identity p { margin: 6px 0 0; color: var(--ink-400); font-size: 10px; }
.vault-key-card__actions { display: flex; align-items: center; gap: 4px; }
.vault-key-card__actions :deep(.el-button + .el-button) { margin-left: 0; }
.vault-key-card__actions small { margin-left: 5px; color: var(--ink-400); }
.vault-key-card__actions .is-danger { color: var(--red-500); }
.vault-empty { width: 100%; margin-top: 18px; padding: 55px 24px; border: 1px dashed var(--ink-200); border-radius: 13px; background: color-mix(in srgb, var(--surface) 78%, transparent); color: var(--ink-500); cursor: pointer; display: grid; place-items: center; }
.vault-empty > span { width: 58px; height: 58px; border-radius: 16px; background: var(--teal-50); color: var(--teal-600); display: grid; place-items: center; }
.vault-empty h3 { margin: 15px 0 0; color: var(--ink-800); }
.vault-empty p { margin: 7px 0 16px; font-size: 12px; }
.vault-empty em { color: var(--teal-700); display: flex; align-items: center; gap: 7px; font-style: normal; font-size: 12px; font-weight: 800; }
.vault-form { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
.form-span-2 { grid-column: 1 / -1; }
.key-file-picker { width: 100%; min-height: 68px; padding: 13px 15px; border: 1px dashed var(--ink-200); border-radius: 8px; background: var(--ink-50); color: var(--teal-700); cursor: pointer; display: flex; align-items: center; gap: 12px; }
.key-file-picker:hover { border-color: var(--teal-400); background: var(--teal-50); }
.key-file-picker input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.key-file-picker strong, .key-file-picker small { display: block; }
.key-file-picker strong { color: var(--ink-800); font-size: 12px; }
.key-file-picker small { margin-top: 4px; color: var(--ink-400); font-size: 10px; }
.vault-dialog-note { padding: 12px 14px; border: 1px solid var(--teal-100); border-radius: 8px; background: var(--teal-50); color: var(--teal-800); display: flex; align-items: center; gap: 9px; font-size: 11px; }
.vault-dialog-note code { color: inherit; font-size: 10px; }
@media (max-width: 900px) { .vault-overview { grid-template-columns: 1fr; } .vault-key-card { grid-template-columns: 42px minmax(0, 1fr); } .vault-key-card__actions { grid-column: 1 / -1; justify-content: flex-end; border-top: 1px solid var(--ink-100); padding-top: 10px; } }
@media (max-width: 640px) { .vault-overview { padding: 20px; } .vault-metrics { grid-template-columns: 1fr; } .vault-metrics article { grid-template-columns: 22px auto 1fr; align-items: center; } .vault-metrics article + article { border-left: 0; border-top: 1px solid var(--ink-100); } .vault-metrics strong { margin: 0; font-size: 15px; } .vault-key-card { padding: 14px; } .vault-key-card__actions { justify-content: flex-start; flex-wrap: wrap; } .vault-form { grid-template-columns: 1fr; } .form-span-2 { grid-column: auto; } }
</style>
