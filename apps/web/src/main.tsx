import "./lib/openCinemaTransport";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@toonflow/node-shared/theme";
import { createRoot } from "react-dom/client";
import Workbench from "./workbench";
import { createWorkbenchController } from "./lib/workbenchController";
import { connectWorkbenchHost } from "./lib/workbenchHost";

const controller = createWorkbenchController();
const element = document.getElementById("app");
if (!element) throw new Error("工作台挂载点不存在");
const root = createRoot(element);
root.render(<Workbench controller={controller} />);

const beforeUnload = (event: BeforeUnloadEvent) => {
  if (!controller.getSnapshot().dirty) return;
  event.preventDefault();
  event.returnValue = "";
};
window.addEventListener("beforeunload", beforeUnload);
let cleanupHost: (() => void) | undefined;
void controller.ready.catch(error => { console.error("插件目录读取失败，打开工程时会重试", error); }).then(async () => {
  const connection = await connectWorkbenchHost(controller);
  cleanupHost = connection.cleanup;
  const parameters = new URLSearchParams(window.location.search);
  const directory = connection.initialCanvas?.directory ?? parameters.get("directory");
  const canvasId = connection.initialCanvas?.canvasId ?? parameters.get("canvas");
  if (directory) {
    // 地址栏里的画布可能已被改名或删除，此时仍打开工程，不把用户退回首页。
    await controller.openProject(directory, canvasId ?? undefined).catch(error => {
      if (!canvasId || connection.initialCanvas) throw error;
      return controller.openProject(directory);
    });
  }
}).catch(error => { console.error("工作台连接或工程打开失败", error); });

if (import.meta.hot) import.meta.hot.dispose(() => {
  window.removeEventListener("beforeunload", beforeUnload);
  cleanupHost?.();
  root.unmount();
  void controller.dispose();
});
