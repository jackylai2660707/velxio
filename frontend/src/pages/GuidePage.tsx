/**
 * 使用說明 — the ONLY documentation surface of the product. Written for
 * students and teachers (non-technical users): how to take a course, use
 * the editor, ask the AI tutor, join a class, and (for teachers) run one.
 * The old developer DocsPage (architecture / Docker / self-hosting) is
 * intentionally not linked anywhere — this is a consumer product.
 */

import { Link } from 'react-router-dom';
import { AppHeader } from '../components/layout/AppHeader';
import { useLocalizedHref } from '../i18n/useLocalizedNavigate';
import { useSEO } from '../utils/useSEO';
import './GuidePage.css';

interface Section {
  id: string;
  emoji: string;
  title: string;
  body: React.ReactNode;
}

export const GuidePage: React.FC = () => {
  const localize = useLocalizedHref();

  useSEO({
    title: '使用說明 — AI物聯網實驗室',
    description:
      '三分鐘上手:怎麼上課、怎麼跑模擬、怎麼問 AI 助教、怎麼加入班級;教師如何建立班級與查看學生成績。',
  });

  const SECTIONS: Section[] = [
    {
      id: 'start',
      emoji: '🚀',
      title: '快速開始(學生)',
      body: (
        <ol>
          <li>
            打開<Link to={localize('/learn')}>「課程」</Link>,從
            <strong>《Arduino 入門》第 1 課</strong>開始。
          </li>
          <li>每一課先讀「原理解說」,再按 <strong>⚡ 開啟本課電路範例</strong> —— 電路和程式會自動出現在編輯器裡。</li>
          <li>
            按編輯器上方的 <strong>▶ 執行</strong>,看電路動起來(LED 會亮、感測器有數值)。
          </li>
          <li>回到課程頁完成「動手挑戰」,做完按 <strong>完成本課</strong>。</li>
          <li>最後做「小測驗」:每題選一個答案,按 <strong>繳交答案</strong> 就會看到對錯和解說,可以一直重試。</li>
        </ol>
      ),
    },
    {
      id: 'editor',
      emoji: '🔧',
      title: '編輯器怎麼用',
      body: (
        <ul>
          <li><strong>▶ 執行 / ⏹ 停止</strong>:編譯你的程式並開始/結束模擬。第一次編譯要等幾秒,ESP32 會久一點。</li>
          <li><strong>加元件</strong>:按畫布上的「＋」打開元件庫,搜尋(例如「LED」)後點選放到畫布上。</li>
          <li><strong>接線</strong>:點一下元件的接腳,再點另一個接腳,線就接好了;線的顏色會自動依訊號種類配色。</li>
          <li><strong>調整元件</strong>:點一下元件可以改它的屬性(例如 LED 顏色、感測器的溫度數值);拖曳可移動。</li>
          <li><strong>序列埠監控視窗</strong>:程式裡 <code>Serial.println(...)</code> 印出的文字會顯示在這裡 —— 按畫布上的「Serial」按鈕打開。</li>
          <li><strong>儲存作品</strong>:登入後可存到雲端帳號;沒登入也可以下載成檔案帶著走。</li>
        </ul>
      ),
    },
    {
      id: 'ai',
      emoji: '🤖',
      title: '問 AI 助教',
      body: (
        <>
          <p>編輯器右側的 AI 助教就像隨時在旁邊的老師,直接用中文跟它說話就可以:</p>
          <ul>
            <li>「幫我做一個溫度超過 30 度就亮紅燈的警報器」—— 它會自己擺元件、接線、寫程式、跑給你看。</li>
            <li>「為什麼我的 LED 不會亮?」—— 它會看你目前的電路找出問題,講解為什麼。</li>
            <li>「這行程式是什麼意思?」—— 它會一次講一個觀念,不會倒一堆術語。</li>
          </ul>
          <p>放心實驗:AI 改動前會自動存檔,跟它說「回到剛才的版本」就能復原。</p>
        </>
      ),
    },
    {
      id: 'class',
      emoji: '🏫',
      title: '加入班級與同步進度',
      body: (
        <ul>
          <li>沒登入也能上課,進度會記在這台電腦裡。</li>
          <li><strong>登入/註冊</strong>(右上角):進度就會同步到帳號,換一台電腦也不會不見。</li>
          <li>老師給你一組 <strong>6 碼班級代碼</strong>:到「課程」頁最上方輸入代碼按「加入班級」,老師就能看到你的進度和測驗成績。</li>
        </ul>
      ),
    },
    {
      id: 'teacher',
      emoji: '👩‍🏫',
      title: '教師指南',
      body: (
        <ol>
          <li>
            <strong>註冊教師帳號</strong>:右上角「登入」→「註冊」,身分選「教師」。
            (如果學校有發「教師註冊碼」,在下方欄位填入。)
          </li>
          <li>
            打開<Link to={localize('/teacher')}>「教學管理」</Link>,輸入班級名稱按
            <strong>建立班級</strong>,會得到一組 6 碼代碼。
          </li>
          <li><strong>把代碼發給學生</strong>(抄在黑板上就行),學生在「課程」頁輸入即加入,不需要收集任何名單。</li>
          <li>點班級卡片即可看<strong>學習報表</strong>:每位學生每一課的完成勾勾與測驗最佳成績,一張表看完全班。</li>
          <li>
            建議教學流程:課堂上先一起做課程裡的範例 → 學生各自完成「動手挑戰」(卡住就問 AI 助教)→
            下課前做小測驗 → 老師在報表確認全班進度。
          </li>
        </ol>
      ),
    },
    {
      id: 'faq',
      emoji: '❓',
      title: '常見問題',
      body: (
        <dl>
          <dt>需要買 Arduino 或安裝軟體嗎?</dt>
          <dd>不用。所有電路和程式都在瀏覽器裡真實模擬,有電腦跟網路就能上課。</dd>
          <dt>我的進度會不見嗎?</dt>
          <dd>沒登入時進度存在這台電腦的瀏覽器裡;建議註冊帳號,進度就會安全地存在雲端。</dd>
          <dt>測驗可以重考嗎?</dt>
          <dd>可以,想考幾次都行,系統會保留你的最佳成績。</dd>
          <dt>模擬跟真的開發板一樣嗎?</dt>
          <dd>程式碼完全一樣 —— 在這裡寫好的程式,拿到真的 Arduino / ESP32 上一樣能跑。</dd>
          <dt>忘記密碼怎麼辦?</dt>
          <dd>請聯絡幫你們架設平台的老師或管理人員協助處理。</dd>
        </dl>
      ),
    },
  ];

  return (
    <div className="guide-page">
      <AppHeader />
      <div className="guide-container">
        <h1>使用說明</h1>
        <p className="guide-subtitle">三分鐘上手。有任何問題,也可以直接在編輯器裡問 AI 助教。</p>

        <nav className="guide-toc">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`}>
              {s.emoji} {s.title}
            </a>
          ))}
        </nav>

        {SECTIONS.map((s) => (
          <section key={s.id} id={s.id} className="guide-section">
            <h2>
              <span aria-hidden>{s.emoji}</span> {s.title}
            </h2>
            <div className="guide-body">{s.body}</div>
          </section>
        ))}

        <div className="guide-cta">
          <Link to={localize('/learn')} className="guide-cta-btn">
            開始上課 →
          </Link>
        </div>
      </div>
    </div>
  );
};
