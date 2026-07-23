# 學習管理系統(LMS)—「AI物聯網實驗室」

本 fork 在 Velxio 模擬器之上加了一層面向初中/高中的學習系統:繁體中文品牌
UI、互動課程、選擇題測驗,以及教師端的班級管理。本文件說明架構與擴充方式。

## 總覽

| 部分 | 位置 | 說明 |
|---|---|---|
| 品牌落地頁 | `frontend/src/pages/BrandLandingPage.tsx` | `/` 首頁,學生/教師導向 |
| 課程資料 | `frontend/src/learn/course-*.ts` | 內容隨前端出貨,型別見 `learn/types.ts` |
| 課程總覽頁 | `frontend/src/pages/LearnPage.tsx` | `/learn`,含進度條與班級加入 |
| 單課頁 | `frontend/src/pages/LessonPage.tsx` | `/learn/:courseId/:lessonId` |
| 測驗元件 | `frontend/src/components/learn/QuizBlock.tsx` | 選擇題、即時回饋、自動計分 |
| 進度 store | `frontend/src/learn/useLearnStore.ts` | local-first + 登入後與伺服器雙向合併 |
| 教師儀表板 | `frontend/src/pages/TeacherPage.tsx` | `/teacher`,建班/代碼/成績報表 |
| 後端 LMS | `backend/app/api/routes/lms.py` | `/api/lms/*`,存於 SQLite(`cloud_db.py`) |
| 後端測試 | `backend/test_lms.py` | 拋棄式 DB 全流程 23 檢查 |

## 語系

- `zh-tw` 為預設語系(`frontend/src/i18n/config.ts` 的 `DEFAULT_LOCALE`),
  `/` 直接是繁體中文;其他語言(含英文)走 `/en/`、`/ja/` 等前綴。
- zh-tw 檔由 zh-cn 經 OpenCC s2twp + 台灣術語表一次性轉換產生,之後直接手改
  `frontend/src/i18n/locales/zh-tw/*.json`(是被提交的正式來源)。
- 新 UI 字串的 key:`brand.*`(落地頁)、`learn.*`(課程)、`teacher.*`
  (教師端)、`cloud.role*`(註冊身分)。`t(key, '繁中預設值')` 寫法保證
  缺 key 時仍顯示繁中。

## 課程內容模型

`frontend/src/learn/types.ts`:

```
Course { id, title, description, level, emoji, lessons[] }
Lesson { id, title, minutes, exampleId?, sections[], challenge?, quiz[] }
LessonSection { heading?, markdown }        // GFM,由 react-markdown 渲染
QuizQuestion { id, question, options[], answer, explanation }
```

重要約定:

- `lessonKey(courseId, lessonId)`(如 `arduino-basics/blink`)是後端進度與
  測驗紀錄的主鍵 — **課程/課次 id 一旦發佈就不可改名**。
- `exampleId` 必須存在於 `frontend/src/data/examples*.ts`;「開啟本課電路
  範例」按鈕即導向既有路由 `/example/:id`(ExampleEditorPage 會載入編輯器)。
- 內容完整性由 `frontend/src/__tests__/learn-content.test.ts` 把關:
  id 唯一、exampleId 存在、每課 ≥3 題、answer index 合法、禁簡體術語。

### 新增一課

1. 在 `course-arduino.ts` / `course-esp32.ts`(或新課程檔 + 在
   `learn/courses.ts` 註冊)加 `Lesson` 物件。
2. 若要配新電路,先在 `data/examples*.ts` 加範例,再填 `exampleId`。
3. `npx vitest run src/__tests__/learn-content.test.ts` 驗證。

## 進度與測驗流程

`useLearnStore`(zustand):

- **Local-first**:完成課次與測驗成績即時寫 `localStorage`
  (`ailab-learn-progress-v1`),匿名學生不會掉進度。
- 登入時(`useCloudStore` user 出現)觸發 `syncWithServer()`:本機獨有的
  完成紀錄推上伺服器,再拉下伺服器狀態取聯集/最佳成績。
- 登入狀態下的每次 markDone / submitQuiz 亦即時 POST `/api/lms/*`。

## 後端

`backend/app/services/cloud_db.py`(stdlib SQLite,沿用 fork 既有帳號棧):

- `users.role`:`'student' | 'teacher'`(對舊庫做就地 `ALTER TABLE` 遷移)。
- `classes`(6 碼班級代碼,去除易混淆字元)、`class_members`、
  `lesson_progress`、`quiz_attempts`。
- 配額:每師 20 班、每班 100 人。

`/api/auth/register` 接受 `role` 與 `teacher_code`;若環境變數
`VELXIO_TEACHER_CODE` 有設定,註冊教師須附上該碼(校方發給老師即可)。

`/api/lms` 端點一覽見 `lms.py` docstring。教師報表
(`GET /classes/{id}/report`)回每位學生的完成課次清單與每課最佳測驗成績,
前端以「課程 × 學生 × 課次」矩陣呈現。

## 管理員(admin)與 AI token 配額

- **admin 帳號**由環境變數 `VELXIO_ADMIN_EMAIL` / `VELXIO_ADMIN_PASSWORD`
  在啟動時自動建立(已存在則升級角色並更新密碼 — 忘記管理密碼時換個
  env 重啟即可救回)。沒有任何自助註冊路徑能取得 admin。
- **管理後台** `/admin`(`frontend/src/pages/AdminPage.tsx`):
  總覽統計、批量建立學生/教師帳號(前綴+編號@網域,密碼自動產生、
  只顯示一次、可下載 CSV,學生可自動加入班級代碼)、帳號表
  (本週用量條、逐人週額度編輯、重設密碼、刪除)。
  API 見 `backend/app/api/routes/admin.py`。
- **AI token 配額**(`cloud_db.py` ai_usage 表):
  - 只有用「伺服器金鑰」(`VELXIO_OPENAI_API_KEY`)的請求才計量;
    自帶金鑰的使用者不設限(自己付費)。匿名者不能用伺服器金鑰(401)。
  - 每人每週額度,週一 00:00 UTC 重置;預設值
    `VELXIO_DEFAULT_WEEKLY_TOKENS`(未設 = 2,000,000),admin 可逐人覆寫。
  - 用量從上游 usage chunk 記帳;上游未回報時以 chars/4 估算,不會漏記。
  - 超額 → `/api/agent/stream` 回 429 與中文說明。
  - 使用者在 AI 面板下方看到「本週 AI 用量」進度條
    (`AgentUsageMeter.tsx`,資料來自 `GET /api/auth/usage`)。
- **平台設定(admin UI 即時可調,存 `platform_settings` 表)**:AI 模型
  (預設 `gpt-5.6-luna`)、推理強度(預設 `high`)、學生/教師各自的
  預設週額度、是否允許使用者自選模型、是否允許自帶 API Key、是否開放
  自助註冊、教師註冊碼。環境變數(`VELXIO_AGENT_MODEL` 等)只作為
  初始種子,UI 儲存後以資料庫為準。運營流程見
  [operations-playbook.md](operations-playbook.md)。
- **速率限制**:登入 10 次/分/IP、註冊 10 次/10 分/IP
  (`app/core/ratelimit.py`,單機記憶體滑動視窗;多實例部署請再加
  反向代理層限流)。
- 測試:`python3 backend/test_admin.py`(27 項)。

## 部署備忘

- SQLite 檔在 `$VELXIO_DATA_DIR`(Docker 內 `/app/data`,已是 volume)。
- 校內/正式部署必設:
  - `VELXIO_ADMIN_EMAIL` / `VELXIO_ADMIN_PASSWORD`(管理員)
  - `VELXIO_OPENAI_BASE_URL` / `VELXIO_OPENAI_API_KEY`(AI 上游)
  - `VELXIO_TEACHER_CODE`(教師自助註冊碼;若帳號全由 admin 發放可不設)
  - `VELXIO_SECRET_KEY`(token 簽章金鑰,不設則自動生成並存於 data 目錄)
  - `VELXIO_DEFAULT_WEEKLY_TOKENS`(選填,預設 2,000,000)
- AI 助教的系統提示已設定預設以繁體中文回覆
  (`frontend/src/agent/systemPrompt.ts`)。

## 尚未涵蓋(後續方向)

- 範例畫廊(`data/examples*.ts`)的標題/描述仍為英文 — 可加
  `titleZh/descriptionZh` 欄位逐步在地化。
- 指派作業(老師指定課次/截止日)、成績匯出 CSV。
- 課程內嵌模擬器(目前跳轉 `/example/:id`,已可滿足教學動線)。
