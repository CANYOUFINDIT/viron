import { createApp } from "vue";
import AgentFloatingOverlay from "./components/AgentFloatingOverlay.vue";
import { i18nPlugin } from "./i18n";

createApp(AgentFloatingOverlay).use(i18nPlugin).mount("#app");
