// ACT: 客户端切换连接会重新加载页面，运行模式只在启动时读取。
const parameters = new URLSearchParams(window.location.search);

export const isMobile = parameters.get("mobile") === "1";
export const isRemoteConnection = parameters.get("remote") === "1";
export const isRemoteMobile = isMobile && isRemoteConnection;
