import { createApp } from "vue";
import ElementPlus from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import "element-plus/dist/index.css";
import "../../styles.css";
import "../../components/admin-ui/admin-ui.css";
import "./preview.css";
import PreviewApp from "./PreviewApp.vue";

createApp(PreviewApp)
  .use(ElementPlus, { locale: zhCn })
  .mount("#admin-ui-preview");
