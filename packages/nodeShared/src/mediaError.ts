export function observeMediaError(media: HTMLMediaElement) {
  let blockedDirective = "";
  function policyViolation(event: SecurityPolicyViolationEvent) {
    const source = media.currentSrc || media.src;
    if (event.disposition !== "enforce" || !["media-src", "default-src"].includes(event.effectiveDirective)) return;
    if (event.blockedURI === source || source.startsWith("blob:") && ["blob", "blob:"].includes(event.blockedURI)) blockedDirective = event.effectiveDirective;
  }
  document.addEventListener("securitypolicyviolation", policyViolation);
  return {
    describe(label = "媒体加载失败") {
      const code = media.error?.code ?? 0;
      const reasons = ["尚未取得可解码的媒体数据", "媒体读取被中止", "媒体读取失败", "媒体解码失败", "当前客户端无法加载此媒体格式"];
      const source = media.currentSrc || media.src;
      const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(source)?.[0] ?? "empty";
      const policy = blockedDirective ? `；页面记录到 ${blockedDirective} 拒绝此类媒体来源` : "";
      return `${label}：${reasons[code] ?? reasons[0]}（MediaError ${code}，readyState ${media.readyState}，networkState ${media.networkState}，来源 ${scheme}${policy}）`;
    },
    dispose() { document.removeEventListener("securitypolicyviolation", policyViolation); },
  };
}
