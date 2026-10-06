# Babylon Sandbox Offline PWA

保留 Babylon.js Sandbox 介面，將引擎、Inspector、環境貼圖、物理解算器、
Draco／Meshopt／KTX2／Basis 解碼器等必要資源一起託管到 GitHub Pages。

第一次開啟需連線下載。上方顯示 **可離線使用** 才代表必要資源已完整保存。
之後可以安裝並離線啟動，開啟本機 glb、glTF、OBJ、STL 或 Babylon 場景。

## 安裝

- Chrome／Edge：網址列安裝圖示或瀏覽器選單「安裝應用程式」。
- iPhone／iPad：Safari 分享選單 →「加入主畫面」。
- 安裝前請等離線下載完成；第一次下載不要關閉頁面。
- glTF／OBJ 相依貼圖、bin、mtl 檔案需一起選取／拖入。支援資料夾的瀏覽器
  可選取整個資料夾；離線使用單一 glb 最方便。
- 模型只在本機開啟，不會由本專案上傳或自動保存。再次開啟需重新選取。

## GitHub Pages

建立公開儲存庫 `Babylon.js-PWA`，將這個專案提交到 `main`。
到 Settings → Pages → Build and deployment，Source 選擇 **GitHub Actions**。
執行 `Build, verify offline, and publish Pages` workflow。

流程會下載原版 Sandbox 已部署的程式與必要資源，檢查 CDN 在下載途中沒有
切換版本，改寫成 Pages 路徑，產生包含 SHA-256 完整性檢查的 precache。
只有完整下載、實際離線瀏覽器驗證成功後才會發佈。每次發佈的原始來源與
檔案摘要可在網站的 `upstream-snapshot.json` 查閱。

Workflow artifacts 另提供整套網站的下載包。PWA 由瀏覽器安裝；下载包需以
HTTPS 或 localhost 伺服器提供，無法直接用 `file://` 安裝。

## 本機建置與驗證

Python 3.12 與 Node.js 22+：

```sh
python -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/service-worker.test.mjs
python scripts/build.py --base-path /Babylon.js-PWA/
npm install --no-save --ignore-scripts playwright@1.62.1
npx playwright install chromium
PAGES_BASE=/Babylon.js-PWA node tests/offline-browser.mjs
```

建置需要網路，使用階段不必重新從 CDN 載入引擎。離線測試會在首次下載完成
後，切斷瀏覽器網路、重新開啟 Sandbox，並載入本機測試 glb 確認有模型網格。

## 離線範圍

- 包含：啟動、本機模型、Inspector、三組內建環境、必要壓縮解碼器。
- 需要網路：使用者指定的線上模型、遠端貼圖、文件與外部編輯器連結。
- 瀏覽器可能在儲存空間不足或清除網站資料後移除離線快取。再次連線下載即可。
- 更新須由使用者按「套用更新」，確認後才重新載入，以免當前模型被意外關閉。
- 這是獨立封裝版本。Babylon.js 與第三方資源的版權／授權見
  `LICENSE`、`THIRD_PARTY_NOTICES.md` 與原始程式中的授權聲明。
