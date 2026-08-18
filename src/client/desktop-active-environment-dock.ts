import { createApp } from "vue";
import "../../tokens.css";
import ActiveEnvironmentDockOverlay from "./components/ActiveEnvironmentDockOverlay.vue";
import { i18nPlugin } from "./i18n";

createApp(ActiveEnvironmentDockOverlay).use(i18nPlugin).mount("#app");
