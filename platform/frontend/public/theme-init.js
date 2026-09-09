(function () {
  try {
    var key = "trading-scene-theme";
    var saved = globalThis.localStorage.getItem(key);
    var theme = saved === "light" || saved === "dark"
      ? saved
      : (globalThis.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    globalThis.document.documentElement.dataset.theme = theme;
    globalThis.document.documentElement.style.colorScheme = theme;
  } catch {
    globalThis.document.documentElement.dataset.theme = "dark";
  }
})();
