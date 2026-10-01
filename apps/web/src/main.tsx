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
void controller.ready.then(async () => {
  const connection = await connectWorkbenchHost(controller);
  cleanupHost = connection.cleanup;
  const parameters = new URLSearchParams(window.location.search);
  const directory = connection.initialCanvas?.directory ?? parameters.get("directory");
  const canvasId = connection.initialCanvas?.canvasId ?? parameters.get("canvas");
  if (directory) {
    await controller.openProject(directory, canvasId ?? undefined);
  }
}).catch(error => { console.error("工作台连接或工程打开失败", error); });

if (import.meta.hot) import.meta.hot.dispose(() => {
  window.removeEventListener("beforeunload", beforeUnload);
  cleanupHost?.();
  root.unmount();
  void controller.dispose();
});
