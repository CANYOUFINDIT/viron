import { createApp } from "vue";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import App from "./App.vue";
import { i18nPlugin, syncDesktopLanguage } from "./i18n";
import { router } from "./router";
import "./styles/base.css";
import "../../tokens.css";
import "./theme";

void syncDesktopLanguage().catch((error) => console.error("[Viron] Failed to synchronize desktop language", error));
createApp(App).use(router).use(ElementPlus).use(i18nPlugin).mount("#app");
