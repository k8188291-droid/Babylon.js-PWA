/* All startup scripts and decoders are hosted locally, inside the Pages scope. */
"use strict";
const APP_ROOT = new URL("./", document.baseURI);
const statusLabel = document.getElementById("offline-status");
const progress = document.getElementById("download-progress");
const retryButton = document.getElementById("retry-button");
const installButton = document.getElementById("install-button");
const updateButton = document.getElementById("update-button");
const helpDialog = document.getElementById("help-dialog");
let registration;
let installPrompt;
let booted = false;
let offlineReady = false;
let activatedUpdate = false;

document.getElementById("help-button").onclick = () => helpDialog.showModal();
helpDialog.addEventListener("click", (event) => { if (event.target === helpDialog) helpDialog.close(); });
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  installButton.hidden = !offlineReady;
});
window.addEventListener("appinstalled", () => { installButton.hidden = true; installPrompt = null; });
installButton.onclick = async () => {
  if (!installPrompt) return;
  await installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  installButton.hidden = true;
};
function showReady() {
  offlineReady = true;
  statusLabel.textContent = navigator.onLine ? "可離線使用" : "離線模式";
  progress.hidden = true;
  retryButton.hidden = true;
  installButton.hidden = !installPrompt;
}
window.addEventListener("online", () => { if (offlineReady) showReady(); });
window.addEventListener("offline", () => { if (offlineReady) showReady(); });
function loadScript(path) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL(path, APP_ROOT).href;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`無法載入 ${path}`));
    document.head.appendChild(script);
  });
}
async function bootSandbox() {
  if (booted) return;
  booted = true;
  try {
    const libraries = [
      "vendor/preview/babylon.js",
      "vendor/preview/addons/babylonjs.addons.min.js",
      "vendor/preview/loaders/babylonjs.loaders.min.js",
      "vendor/preview/serializers/babylonjs.serializers.min.js",
      "vendor/preview/materialsLibrary/babylonjs.materials.min.js",
      "vendor/preview/gui/babylon.gui.min.js",
      "vendor/preview/inspector/babylon.inspector-v2.bundle.js",
      "vendor/cdn/ammo.js",
      "vendor/cdn/havok/HavokPhysics_umd.js",
      "vendor/cdn/cannon.js",
      "vendor/cdn/Oimo.js",
      "babylon.sandbox.js"
    ];
    for (const library of libraries) await loadScript(library);
    const base = new URL("vendor/cdn/", APP_ROOT).href.replace(/\/$/, "");
    BABYLON.Tools.CDNBaseUrl = base;
    BABYLON.Tools.ScriptBaseUrl = base;
    BABYLON.Tools.AssetBaseUrl = base;
    if (BABYLON.DracoDecoder) BABYLON.DracoDecoder.DefaultConfiguration = {
      wasmUrl: base + "/draco_wasm_wrapper_gltf.js",
      wasmBinaryUrl: base + "/draco_decoder_gltf.wasm",
      fallbackUrl: base + "/draco_decoder_gltf.js"
    };
    if (BABYLON.MeshoptCompression) BABYLON.MeshoptCompression.Configuration.decoder = { url: base + "/meshopt_decoder.js" };
    if (BABYLON.GLTFValidation) BABYLON.GLTFValidation.Configuration = { url: base + "/gltf_validator.js" };
    if (BABYLON.KhronosTextureContainer2) BABYLON.KhronosTextureContainer2.URLConfig = {
      jsDecoderModule: base + "/babylon.ktx2Decoder.js",
      wasmUASTCToASTC: base + "/ktx2Transcoders/1/uastc_astc.wasm",
      wasmUASTCToBC7: base + "/ktx2Transcoders/1/uastc_bc7.wasm",
      wasmUASTCToRGBA_UNORM: base + "/ktx2Transcoders/1/uastc_rgba8_unorm_v2.wasm",
      wasmUASTCToRGBA_SRGB: base + "/ktx2Transcoders/1/uastc_rgba8_srgb_v2.wasm",
      jsMSCTranscoder: base + "/ktx2Transcoders/1/msc_basis_transcoder.js",
      wasmMSCTranscoder: base + "/ktx2Transcoders/1/msc_basis_transcoder.wasm",
      wasmZSTDDecoder: base + "/zstddec.wasm"
    };
    if (BABYLON.BasisToolsOptions) {
      BABYLON.BasisToolsOptions.JSModuleURL = base + "/basisTranscoder/1/basis_transcoder.js";
      BABYLON.BasisToolsOptions.WasmModuleURL = base + "/basisTranscoder/1/basis_transcoder.wasm";
    }
    BABYLON.Sandbox.Show(document.getElementById("host-element"), { version: "", bundles: libraries.map(path => new URL(path, APP_ROOT).href) });
    document.getElementById("boot-message")?.remove();
  } catch (error) {
    booted = false;
    statusLabel.textContent = "Sandbox 載入失敗";
    const message = document.getElementById("boot-message") || document.getElementById("host-element").appendChild(Object.assign(document.createElement("div"), { id: "boot-message" }));
    message.textContent = `Sandbox 載入失敗：${error.message}。請連線後重新下載。`;
    retryButton.hidden = false;
  }
}
function requestStatus(worker) { worker?.postMessage({ type: "STATUS" }); }
function watchUpdate() {
  if (registration.waiting) updateButton.hidden = false;
  const watchInstalling = () => {
    const worker = registration.installing;
    worker?.addEventListener("statechange", () => {
      if (worker.state === "installed" && registration.waiting && navigator.serviceWorker.controller) updateButton.hidden = false;
      if (worker.state === "redundant" && !offlineReady) {
        statusLabel.textContent = "下載未完成，請保持連線後重試";
        progress.hidden = true;
        retryButton.hidden = false;
      }
    });
  };
  watchInstalling();
  registration.addEventListener("updatefound", watchInstalling);
}
updateButton.onclick = () => {
  if (!registration.waiting) return;
  if (!confirm("套用更新會重新開啟 Sandbox；目前模型需要重新選取。繼續嗎？")) return;
  activatedUpdate = true;
  registration.waiting.postMessage({ type: "ACTIVATE" });
};
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.addEventListener("message", async (event) => {
    const data = event.data;
    if (data?.type === "PROGRESS") {
      statusLabel.textContent = `離線下載 ${data.done}/${data.total}`;
      progress.max = data.total; progress.value = data.done;
    }
    if (data?.type === "READY" && data.ready) { showReady(); await bootSandbox(); }
    if (data?.type === "READY" && !data.ready) {
      statusLabel.textContent = "離線資源不完整，請連線後重新下載";
      progress.hidden = true; retryButton.hidden = false;
    }
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (activatedUpdate) { location.reload(); return; }
    requestStatus(navigator.serviceWorker.controller);
  });
  async function prepare() {
    retryButton.hidden = true;
    statusLabel.textContent = "正在準備離線資源…";
    progress.hidden = false;
    try {
      registration = await navigator.serviceWorker.register("sw.js", { scope: "./", updateViaCache: "none" });
      watchUpdate();
      if (navigator.serviceWorker.controller) requestStatus(navigator.serviceWorker.controller);
      else navigator.serviceWorker.ready.then(() => requestStatus(navigator.serviceWorker.controller || registration.active));
    } catch (error) {
      statusLabel.textContent = "無法準備離線資源，請連線後重試";
      progress.hidden = true; retryButton.hidden = false;
    }
  }
  retryButton.onclick = async () => {
    if (navigator.serviceWorker.controller) {
      statusLabel.textContent = "正在重新下載離線資源…";
      progress.hidden = false; retryButton.hidden = true;
      navigator.serviceWorker.controller.postMessage({ type: "REPAIR" });
    } else await prepare();
  };
  prepare();
} else {
  statusLabel.textContent = "此瀏覽器不支援離線安裝";
  progress.hidden = true;
  bootSandbox();
}
