import { createApp } from "vue";
import "./styles/cu-tokens.css";
import "./style.css";
import "./styles/design-tokens.css";
import "./styles/cu-kit.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans-condensed/500.css";
import "@fontsource/ibm-plex-sans-condensed/600.css";
import "@fontsource/ibm-plex-sans-condensed/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import App from "./App.vue";
import i18n from "./kernel/i18n";
import { installErrorLogging, reportFatal } from "./kernel/logging";
import { installTheme } from "./kernel/theme";

installErrorLogging();
installTheme();

const app = createApp(App);
app.config.errorHandler = (err, _instance, info) => {
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(err);
    void reportFatal(`Ошибка Vue (${info})`, detail);
};
app.use(i18n).mount("#app");
