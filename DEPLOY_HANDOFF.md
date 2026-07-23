# DEPLOY_HANDOFF —「AI物聯網實驗室」上線部署交接

> **給在伺服器上執行的 Claude(部署代理)**:這份文件就是你的任務書。
> 你所在的機器是生產伺服器,目標是把本 repo 的平台以 HTTPS 部署上線。
> 程式碼已完成、測試全綠 —— **你的工作只是部署與驗證,不要改產品程式碼**。
> 有問題先查本文件的「疑難排解」;真的要改碼,只允許改 `deploy/` 目錄。

## 這是什麼

「AI物聯網實驗室」— 給初中/高中學生與教師的繁體中文物聯網學習平台
(基於開源專案 Velxio 改造):瀏覽器內 Arduino/ESP32 模擬器 + 互動課程
+ 選擇題測驗 + 師生班級管理 + AI 助教(每人每週 token 配額)+ 管理後台。

- 部署形態:單一 Docker 容器(nginx SPA + FastAPI + arduino-cli + QEMU),
  前面掛 Caddy 自動 HTTPS。`deploy/` 目錄已備好 compose 檔。
- 狀態:`master` 即最新;前端 2290 測試、後端 36+23 測試、瀏覽器 E2E 24 項全綠。
- 營運手冊(給人類管理員):`docs/wiki/operations-playbook.md`
- 系統結構:`docs/wiki/learning-system.md`

## 第 0 步:先向操作者要這些資訊(缺一不可,先問再動工)

1. **網域名稱**(如 `lab.example.com`)— 並確認 DNS A 記錄已指向本機公網 IP
   (`dig +short 網域` 應回本機 IP;`curl ifconfig.me` 取本機 IP)。
2. **TLS 通知信箱**。
3. **管理員帳號/密碼**(`VELXIO_ADMIN_EMAIL` / `VELXIO_ADMIN_PASSWORD`)。
4. **AI 上游**:OpenAI 相容的 `base_url` 與 `api_key`(這是平台成本來源)。
5. **QEMU 二進位的取得方式**(見第 2 步,二選一)。
6. 確認防火牆/雲安全組已開 **80 與 443**。

## 第 1 步:安裝 Docker(若尚未安裝)

```bash
docker --version && docker compose version   # 都有就跳過
# Ubuntu/Debian:
curl -fsSL https://get.docker.com | sh
```

## 第 2 步:QEMU 執行庫(ESP32 模擬必需,擇一)

Docker build 需要 `libqemu-xtensa.so` / `libqemu-riscv32.so` + 3 個
`esp32*-rom.bin`。它們**不在 git 裡**(授權管制)。兩個取法:

**方法 A(推薦,免費):** 請操作者到 https://velxio.dev/license/signup
申請免費個人金鑰(`vlx_personal_...`),填進 `deploy/.env` 的
`VELXIO_LICENSE_KEY`,build 時會自動下載。

**方法 B(離線):** 從上游公開 Docker 映像抽出,放進 `prebuilt/qemu/`:

```bash
docker pull davidmonterocrespo/velxio:master   # 僅有 master 標籤
id=$(docker create davidmonterocrespo/velxio:master)
docker cp "$id":/app/lib/. prebuilt/qemu/
docker rm "$id"
ls prebuilt/qemu/   # 應見 2 個 .so + 3 個 .bin(此目錄已 gitignore,勿提交)
```

## 第 3 步:設定並啟動

```bash
cd deploy
cp .env.example .env
$EDITOR .env        # 填入第 0 步收集的資訊(DOMAIN/FRONTEND_URL 要一致)
docker compose up -d --build
```

**耐心**:首次 build 要下載 ESP-IDF 工具鏈與前端依賴,約 20–60 分鐘
(之後重建有快取,很快)。用 `docker compose logs -f app` 盯進度。
build 若在 qemu-provider 階段報錯,回到第 2 步。

## 第 4 步:驗證清單(逐項打勾,全過才算部署完成)

```bash
D=https://你的網域
curl -sI $D/ | head -1                         # HTTP/2 200,且是 https
curl -s $D/ | grep -o '<title>[^<]*'           # 標題含「AI物聯網實驗室」
curl -s $D/api/agent/config | python3 -m json.tool   # model=gpt-5.6-luna, effort=high, server_has_key=true
curl -s $D/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"<admin email>","password":"<admin pw>"}' | head -c 80   # 有 token
```

瀏覽器(可用 puppeteer,系統沒裝 Chrome 就請操作者手動點):
1. `/` 品牌落地頁繁中顯示、電路動畫在動。
2. 右上角登入 admin → 導覽列出現「管理後台」。
3. `/admin`:平台設定卡可儲存;批量建 2 個測試學生 → 出現密碼表。
4. 用測試學生登入 → `/learn` 選一課 → 「開啟本課電路範例」→ 編輯器
   按 ▶ 執行 → **LED 有反應**(這一步驗證了編譯後端 + AVR 模擬全鏈路)。
5. 課程頁做完小測驗 → 顯示得分。
6. AI 助教面板發一句「你好」→ 有回覆、面板下方出現「本週 AI 用量」條
   (這驗證了 AI 上游 + 計量)。
7. ESP32 冒煙(可選,首次很慢):範例開 `esp32-blink-led` → 執行 →
   等編譯(首次可能 3–10 分鐘,裝 esp32 工具鏈)→ 有序列輸出。
8. 刪掉測試學生(管理後台)。

## 第 5 步:收尾(必做)

1. 提醒操作者到 `/admin` 平台設定:**建議關閉「開放自助註冊」與
   「允許自選模型」**(封閉商用模式,成本可控)。
2. 裝每日備份 cron(SQLite + secret key 全在 app-data volume):
   ```bash
   cat >/etc/cron.daily/ailab-backup <<'EOF'
   #!/bin/sh
   docker run --rm -v deploy_app-data:/data -v /var/backups/ailab:/backup alpine \
     sh -c 'tar czf /backup/ailab-$(date +%F).tar.gz -C /data . && ls -t /backup | tail -n +15 | xargs -r -I{} rm /backup/{}'
   EOF
   chmod +x /etc/cron.daily/ailab-backup
   ```
   (volume 名稱以 `docker volume ls | grep app-data` 實際輸出為準。)
3. 向操作者回報:網址、驗證清單結果、備份位置、下一步指引
   (`docs/wiki/operations-playbook.md` 的新客戶開通 SOP)。

## 疑難排解

| 症狀 | 處置 |
|---|---|
| build 在 qemu-provider 失敗並列出兩個選項 | 就是第 2 步沒做 — 補 license key 或 prebuilt 檔 |
| Caddy 起不來 / 憑證失敗 | DNS 未生效或 80/443 被占用;`docker compose logs caddy`;`ss -tlnp | grep -E ':80|:443'` |
| 前端好但 `/api/*` 502 | app 容器還在啟動或崩了:`docker compose logs -f app` |
| AI 面板報 401「請先登入」 | 正常 — 伺服器金鑰模式下匿名不能用 AI;登入即可 |
| AI 報 429 週額度 | 正常 — 管理後台調該帳號額度 |
| AI 無回應但 config 正常 | 上游 base_url/key 有誤:面板設定裡按「測試連線」看錯誤;或 `docker compose exec app curl -s $VELXIO_OPENAI_BASE_URL/models -H "Authorization: Bearer $VELXIO_OPENAI_API_KEY"` |
| ESP32 範例開機就 Guru Meditation「Cache disabled…」 | 幾乎不會發生在 Docker 版(映像自帶 arduino-esp32 2.0.17);若見到,代表有人在容器裡另裝了 esp32 core 3.x — 移除它 |
| 改了 .env 沒生效 | `docker compose up -d` 重建容器(env 是啟動時注入) |

## 紅線(不要做)

- 不要修產品程式碼/前端樣式/課程內容;部署問題只動 `deploy/`。
- 不要把 `.env`、`prebuilt/qemu/*.so|*.bin` commit 進 git(已 gitignore)。
- 不要跑 `npm audit fix`、不要升級依賴。
- 不要在容器裡手動裝 esp32 arduino core(映像用的是內建 ESP-IDF 路徑)。
- 資料都在 volumes — `docker compose down` 別加 `-v`。
