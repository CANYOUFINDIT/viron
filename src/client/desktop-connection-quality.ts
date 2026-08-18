import { createApp } from "vue";
import { i18nPlugin } from "./i18n";
import ConnectionQualityOverlay from "./components/ConnectionQualityOverlay.vue";

createApp(ConnectionQualityOverlay).use(i18nPlugin).mount("#app");
