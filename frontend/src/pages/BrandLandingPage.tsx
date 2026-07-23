/**
 * 「AI物聯網實驗室」brand landing page — replaces the upstream marketing
 * LandingPage at `/`. Aimed at middle/high-school students and teachers:
 * a short hero, the three pillars (simulator / courses / quizzes+classes),
 * a teacher call-out, and a board strip. All copy via i18n `brand.*` keys
 * (zh-tw is the default locale; en carries translations).
 */

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AppHeader } from '../components/layout/AppHeader';
import { useLocalizedHref } from '../i18n/useLocalizedNavigate';
import { useSEO } from '../utils/useSEO';
import './BrandLandingPage.css';

const BOARDS = [
  'Arduino Uno',
  'Arduino Nano',
  'Arduino Mega',
  'ESP32',
  'ESP32-C3',
  'ESP32-S3',
  'Raspberry Pi Pico',
  'ATtiny85',
];

export const BrandLandingPage: React.FC = () => {
  const { t } = useTranslation();
  const localize = useLocalizedHref();

  useSEO({
    title: t(
      'brand.seoTitle',
      'AI物聯網實驗室 — 免費線上 Arduino / ESP32 模擬器與物聯網課程平台'
    ),
    description: t(
      'brand.seoDescription',
      '為初中、高中學生與教師打造的免費開源學習平台:瀏覽器內模擬 Arduino、ESP32 等 19 種開發板,內建互動課程、選擇題測驗、班級管理與 AI 智慧助教。'
    ),
  });

  return (
    <div className="brand-landing">
      <AppHeader />

      {/* ── Hero ─────────────────────────────────────────────── */}
      <section className="brand-hero">
        <div className="brand-hero-badge">
          {t('brand.hero.badge', '免費 · 開源 · 免安裝 · 免硬體')}
        </div>
        <h1 className="brand-hero-title">
          {t('brand.hero.titleTop', '在瀏覽器裡,')}
          <span className="brand-hero-accent">
            {t('brand.hero.titleAccent', '打開你的物聯網實驗室')}
          </span>
        </h1>
        <p className="brand-hero-subtitle">
          {t(
            'brand.hero.subtitle',
            '寫程式、接電路、跑模擬 — Arduino 與 ESP32 就在眼前動起來。跟著互動課程一步步學,AI 助教隨時解答,老師還能掌握全班進度。'
          )}
        </p>
        <div className="brand-hero-ctas">
          <Link to={localize('/learn')} className="brand-cta brand-cta-primary">
            {t('brand.hero.ctaLearn', '開始上課')}
          </Link>
          <Link to={localize('/editor')} className="brand-cta brand-cta-secondary">
            {t('brand.hero.ctaEditor', '進入實驗室')}
          </Link>
        </div>
        <div className="brand-hero-boards">
          {BOARDS.map((b) => (
            <span key={b} className="brand-board-chip">
              {b}
            </span>
          ))}
        </div>
      </section>

      {/* ── Three pillars ────────────────────────────────────── */}
      <section className="brand-features">
        <div className="brand-feature-card">
          <div className="brand-feature-icon" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="5" width="14" height="14" rx="2" />
              <rect x="9" y="9" width="6" height="6" />
              <path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" />
            </svg>
          </div>
          <h3>{t('brand.features.sim.title', '真實模擬器')}</h3>
          <p>
            {t(
              'brand.features.sim.desc',
              '不是動畫,是真的在跑你的程式:AVR、ESP32、RP2040 晶片級模擬,100+ 個電子元件、示波器與序列埠監控,跟真實硬體一樣的行為。'
            )}
          </p>
        </div>
        <div className="brand-feature-card">
          <div className="brand-feature-icon" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
          </div>
          <h3>{t('brand.features.courses.title', '互動課程')}</h3>
          <p>
            {t(
              'brand.features.courses.desc',
              '從點亮第一顆 LED 到 ESP32 連上網路,每一課都有原理解說、可一鍵載入的電路範例,以及動手挑戰 — 邊做邊學,不用背講義。'
            )}
          </p>
        </div>
        <div className="brand-feature-card">
          <div className="brand-feature-icon" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
          </div>
          <h3>{t('brand.features.quiz.title', '測驗與班級管理')}</h3>
          <p>
            {t(
              'brand.features.quiz.desc',
              '每課附選擇題測驗、即時對錯回饋與自動計分;老師建立班級代碼,學生一鍵加入,儀表板即時呈現全班進度與成績。'
            )}
          </p>
        </div>
      </section>

      {/* ── AI assistant ─────────────────────────────────────── */}
      <section className="brand-ai">
        <div className="brand-ai-text">
          <h2>{t('brand.ai.title', 'AI 智慧助教,隨時在旁邊')}</h2>
          <p>
            {t(
              'brand.ai.desc',
              '用中文說「幫我做一個溫度警報器」,AI 助教就會在你的畫布上擺元件、接線、寫程式、跑模擬給你看;卡關的時候問它為什麼,它會像老師一樣,一次講一個觀念。'
            )}
          </p>
          <Link to={localize('/editor')} className="brand-cta brand-cta-primary">
            {t('brand.ai.cta', '試試 AI 助教')}
          </Link>
        </div>
        <div className="brand-ai-demo" aria-hidden>
          <div className="brand-chat-bubble brand-chat-user">
            {t('brand.ai.demoUser', '為什麼我的 LED 不會亮?')}
          </div>
          <div className="brand-chat-bubble brand-chat-ai">
            {t(
              'brand.ai.demoAi',
              '我看了你的電路:LED 的陰極接到了 D13,應該接 GND 才能形成迴路。要我幫你改好並示範一次嗎?'
            )}
          </div>
        </div>
      </section>

      {/* ── Teacher call-out ─────────────────────────────────── */}
      <section className="brand-teacher">
        <h2>{t('brand.teacherSection.title', '給老師:一間開箱即用的電腦教室')}</h2>
        <p>
          {t(
            'brand.teacherSection.desc',
            '不用採購硬體、不用安裝軟體:開一個班級代碼,學生用瀏覽器就能做完整個學期的實驗。課程進度、測驗成績一目了然,還能自行架設在校內伺服器,資料完全自主。'
          )}
        </p>
        <Link to={localize('/teacher')} className="brand-cta brand-cta-secondary">
          {t('brand.teacherSection.cta', '前往教學管理')}
        </Link>
      </section>

      {/* ── Footer ───────────────────────────────────────────── */}
      <footer className="brand-footer">
        <span>{t('brand.name', 'AI物聯網實驗室')}</span>
        <span className="brand-footer-sep">·</span>
        <span>
          {t('brand.footer.oss', '開源軟體(AGPLv3 授權)')}
        </span>
        <span className="brand-footer-sep">·</span>
        {/* AGPLv3 §13: network users must be offered the source. */}
        <a
          href="https://github.com/jackylai2660707/velxio"
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('brand.footer.source', '原始碼')}
        </a>
      </footer>
    </div>
  );
};
