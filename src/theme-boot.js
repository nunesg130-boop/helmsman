// Runs before the first paint, ahead of the stylesheets' first use.
// "Reduce transparency" is chosen per browser in Settings > Appearance; it
// is applied here so glass panels never flash before turning solid. The
// theme itself needs no script: the server writes it into <html data-theme>.
(function applyTransparencyChoice() {
  try {
    if (globalThis.localStorage?.getItem("helmsman.transparency") === "reduced") {
      document.documentElement.dataset.transparency = "reduced";
    }
  } catch {
    // Storage is blocked; the operating system setting still applies.
  }
})();
