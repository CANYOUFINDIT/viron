import { createApp } from "vue";
import DesktopWebPopupChrome from "./components/DesktopWebPopupChrome.vue";
import { i18nPlugin } from "./i18n";

createApp(DesktopWebPopupChrome).use(i18nPlugin).mount("#app");
