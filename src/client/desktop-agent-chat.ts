import { createApp } from "vue";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import AgentFloatingWindow from "./components/AgentFloatingWindow.vue";
import { desktopState } from "./desktop";
import { elementPlusLocale, i18nPlugin, syncDesktopLanguage } from "./i18n";
import { initializeAppShortcuts } from "./keyboard-shortcuts";
import "../../tokens.css";

window.vironAgentChatOverlay = true;
document.documentElement.classList.add("is-agent-chat-overlay");

void syncDesktopLanguage().catch(() => undefined);
void desktopState().catch(() => undefined);
void initializeAppShortcuts().catch(() => undefined);

const app = createApp(AgentFloatingWindow);
app.use(ElementPlus, { locale: elementPlusLocale.value });
app.use(i18nPlugin);
app.mount("#app");
