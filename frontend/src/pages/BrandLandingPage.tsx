/**
 * 「AI物聯網實驗室」brand landing page.
 *
 * The hero centerpiece is a hand-built, *living* SVG circuit board — no
 * three.js (school networks need instant loads): current pulses travel the
 * copper traces via SVG animateMotion, the LED blinks in sync with the
 * highlighted line of the floating code card, the push-button is really
 * clickable (press → LED forced on, matching how INPUT wiring works), the
 * DHT11 readout ticks live, and the whole board tilts in 3D following the
 * pointer. Sections below reveal on scroll via IntersectionObserver.
 *
 * IMPORTANT: this file only touches the landing page — nothing here is
 * shared with the simulator/editor system.
 */

import { useEffect, useRef, useState } from 'react';
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

/** Adds .revealed once the element scrolls into view (one-shot). */
function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.classList.add('revealed');
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('revealed');
            obs.unobserve(e.target);
          }
        }
      },
      { threshold: 0.18 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return ref;
}

/* ── The living circuit board ─────────────────────────────────────────── */

const LivingCircuit: React.FC = () => {
  const [ledOn, setLedOn] = useState(true);
  const [pressed, setPressed] = useState(false);
  const [temp, setTemp] = useState(25.4);
  const [tilt, setTilt] = useState({ rx: 0, ry: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);

  // Firmware heartbeat: LED blinks unless the button holds it on (the
  // press handler itself forces the LED on, so the effect only owns the
  // blink interval).
  useEffect(() => {
    if (pressed) return;
    const t = setInterval(() => setLedOn((v) => !v), 850);
    return () => clearInterval(t);
  }, [pressed]);

  const press = (down: boolean) => {
    setPressed(down);
    if (down) setLedOn(true);
  };

  // DHT11 readout drifts like a real sensor.
  useEffect(() => {
    const t = setInterval(
      () => setTemp((v) => Math.round((v + (Math.random() - 0.5) * 0.4) * 10) / 10),
      1600
    );
    return () => clearInterval(t);
  }, []);

  const onMove = (e: React.MouseEvent) => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    setTilt({ rx: -py * 10, ry: px * 12 });
  };

  return (
    <div
      ref={wrapRef}
      className="circuit-stage"
      onMouseMove={onMove}
      onMouseLeave={() => setTilt({ rx: 0, ry: 0 })}
      aria-hidden
    >
      <div
        className="circuit-tilt"
        style={{ transform: `perspective(1100px) rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg)` }}
      >
        <svg className="circuit-svg" viewBox="0 0 560 430" fill="none">
          <defs>
            <filter id="lc-glow" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="7" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id="lc-glow-soft" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="3.2" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <linearGradient id="lc-board" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#0e1a26" />
              <stop offset="1" stopColor="#0a1420" />
            </linearGradient>
            <linearGradient id="lc-chip" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#22344a" />
              <stop offset="1" stopColor="#131f30" />
            </linearGradient>
            <radialGradient id="lc-led-on" cx="0.5" cy="0.4" r="0.7">
              <stop offset="0" stopColor="#ffd0d0" />
              <stop offset="0.35" stopColor="#ff5b5b" />
              <stop offset="1" stopColor="#c81e1e" />
            </radialGradient>
            <pattern id="lc-dots" width="22" height="22" patternUnits="userSpaceOnUse">
              <circle cx="2" cy="2" r="1.1" fill="rgba(88,166,255,0.10)" />
            </pattern>
            {/* Copper trace routes (also used as motion paths) */}
            <path id="lc-t-led" d="M 322 176 H 380 Q 392 176 392 164 V 128 Q 392 116 404 116 H 438" />
            <path id="lc-t-btn" d="M 322 232 H 372 Q 384 232 384 244 V 300 Q 384 312 396 312 H 430" />
            <path id="lc-t-dht" d="M 238 176 H 186 Q 174 176 174 164 V 130 Q 174 118 162 118 H 120" />
            <path id="lc-t-pwr" d="M 238 232 H 172 Q 160 232 160 244 V 296 Q 160 308 148 308 H 96" />
          </defs>

          {/* PCB */}
          <rect x="30" y="26" width="500" height="378" rx="22" fill="url(#lc-board)" stroke="rgba(88,166,255,0.28)" strokeWidth="1.4" />
          <rect x="30" y="26" width="500" height="378" rx="22" fill="url(#lc-dots)" />
          {/* mounting holes */}
          {[[54, 50], [506, 50], [54, 380], [506, 380]].map(([x, y]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r="7" fill="#0a0f16" stroke="rgba(148,163,184,0.35)" strokeWidth="1.4" />
          ))}
          {/* silkscreen */}
          <text x="52" y="398" className="lc-silk">AI-IOT-LAB · REV 1.0</text>

          {/* traces */}
          {(['lc-t-led', 'lc-t-btn', 'lc-t-dht', 'lc-t-pwr'] as const).map((id) => (
            <use key={id} href={`#${id}`} stroke="rgba(88,166,255,0.22)" strokeWidth="4" strokeLinecap="round" />
          ))}
          {/* current pulses */}
          <circle r="3.4" fill="#7ee2ff" filter="url(#lc-glow-soft)" className="lc-pulse">
            <animateMotion dur="2.4s" repeatCount="indefinite">
              <mpath href="#lc-t-led" />
            </animateMotion>
          </circle>
          <circle r="3.4" fill="#7effc0" filter="url(#lc-glow-soft)" className="lc-pulse">
            <animateMotion dur="3s" begin="0.6s" repeatCount="indefinite" keyPoints="1;0" keyTimes="0;1" calcMode="linear">
              <mpath href="#lc-t-btn" />
            </animateMotion>
          </circle>
          <circle r="3.4" fill="#c8a6ff" filter="url(#lc-glow-soft)" className="lc-pulse">
            <animateMotion dur="2.8s" begin="0.3s" repeatCount="indefinite">
              <mpath href="#lc-t-dht" />
            </animateMotion>
          </circle>
          <circle r="3.4" fill="#ffb46e" filter="url(#lc-glow-soft)" className="lc-pulse">
            <animateMotion dur="3.4s" begin="1.1s" repeatCount="indefinite" keyPoints="1;0" keyTimes="0;1" calcMode="linear">
              <mpath href="#lc-t-pwr" />
            </animateMotion>
          </circle>

          {/* resistor on the LED trace */}
          <g transform="translate(346 168)">
            <rect x="0" y="0" width="26" height="16" rx="4" fill="#caa26a" stroke="#8a6a3c" />
            <rect x="5" y="0" width="3.5" height="16" fill="#7c3aed" />
            <rect x="12" y="0" width="3.5" height="16" fill="#dc2626" />
            <rect x="19" y="0" width="3.5" height="16" fill="#eab308" />
          </g>

          {/* MCU */}
          <g className="lc-mcu">
            {/* pins */}
            {Array.from({ length: 5 }, (_, i) => (
              <g key={i}>
                <rect x={244 + i * 16} y="146" width="7" height="12" rx="2" fill="#3b4c63" />
                <rect x={244 + i * 16} y="250" width="7" height="12" rx="2" fill="#3b4c63" />
                <rect x="226" y={168 + i * 16} width="12" height="7" rx="2" fill="#3b4c63" />
                <rect x="322" y={168 + i * 16} width="12" height="7" rx="2" fill="#3b4c63" />
              </g>
            ))}
            <rect x="238" y="156" width="84" height="96" rx="10" fill="url(#lc-chip)" stroke="rgba(120,180,255,0.55)" strokeWidth="1.4" />
            <rect x="238" y="156" width="84" height="96" rx="10" className="lc-chip-sheen" />
            <text x="280" y="197" className="lc-chip-brand">AI</text>
            <text x="280" y="220" className="lc-chip-sub">IoT LAB</text>
            <circle cx="250" cy="168" r="2.6" fill={ledOn ? '#4ade80' : '#1f2c3d'} filter={ledOn ? 'url(#lc-glow-soft)' : undefined} />
          </g>

          {/* LED (pin 13) */}
          <g transform="translate(452 116)">
            <line x1="-6" y1="18" x2="6" y2="18" stroke="#94a3b8" strokeWidth="2.4" />
            <circle cx="0" cy="0" r="13" fill={ledOn ? 'url(#lc-led-on)' : '#3a1418'} stroke={ledOn ? '#ff8f8f' : '#5b2a2e'} strokeWidth="1.6" filter={ledOn ? 'url(#lc-glow)' : undefined} />
            <text x="0" y="34" className="lc-label">LED 13</text>
          </g>

          {/* DHT11 */}
          <g transform="translate(74 92)">
            <rect x="0" y="8" width="46" height="52" rx="7" fill="#2563eb" stroke="#60a5fa" strokeWidth="1.2" />
            {Array.from({ length: 3 }, (_, r) =>
              Array.from({ length: 3 }, (_, c) => (
                <circle key={`${r}${c}`} cx={11 + c * 12} cy={22 + r * 12} r="2.6" fill="#0f2c66" />
              ))
            )}
            <text x="23" y="76" className="lc-label">DHT11</text>
            {/* live readout bubble */}
            <g transform="translate(58 -14)">
              <rect x="0" y="0" width="66" height="26" rx="13" fill="rgba(10,20,32,0.9)" stroke="rgba(126,226,255,0.5)" />
              <text x="33" y="17" className="lc-readout">{temp.toFixed(1)}°C</text>
            </g>
          </g>

          {/* Push button (clickable) */}
          <g
            transform="translate(452 312)"
            className="lc-button"
            pointerEvents="all"
            onMouseDown={() => press(true)}
            onMouseUp={() => press(false)}
            onMouseLeave={() => press(false)}
            onTouchStart={() => press(true)}
            onTouchEnd={() => press(false)}
          >
            <rect x="-22" y="-22" width="44" height="44" rx="8" fill="#16202e" stroke="rgba(148,163,184,0.5)" strokeWidth="1.3" />
            {[[-15, -15], [15, -15], [-15, 15], [15, 15]].map(([x, y]) => (
              <circle key={`${x}${y}`} cx={x} cy={y} r="2.6" fill="#94a3b8" />
            ))}
            <circle cx="0" cy="0" r={pressed ? 11.5 : 13} fill={pressed ? '#dc2626' : '#ef4444'} stroke="#7f1d1d" strokeWidth="2" />
            <text x="0" y="36" className="lc-label">{pressed ? 'LOW' : '按我'}</text>
          </g>

          {/* Power pads */}
          <g transform="translate(72 296)">
            <rect x="0" y="0" width="30" height="24" rx="5" fill="#16202e" stroke="rgba(255,180,110,0.5)" />
            <text x="15" y="16" className="lc-pad">5V</text>
          </g>
        </svg>

        {/* Floating firmware card — the highlighted line follows the LED */}
        <div className="circuit-code">
          <div className="circuit-code-bar">
            <span /><span /><span />
            <em>sketch.ino</em>
          </div>
          <pre>
            <code>
              <span className="cc-kw">void</span> <span className="cc-fn">loop</span>() {'{'}{'\n'}
              <span className={ledOn && !pressed ? 'cc-line cc-active' : 'cc-line'}>
                {'  '}digitalWrite(<span className="cc-num">13</span>, HIGH);
              </span>
              {'\n'}
              <span className={!ledOn && !pressed ? 'cc-line cc-active' : 'cc-line'}>
                {'  '}digitalWrite(<span className="cc-num">13</span>, LOW);
              </span>
              {'\n'}
              <span className={pressed ? 'cc-line cc-active' : 'cc-line'}>
                {'  '}<span className="cc-cm">{pressed ? '// 按鈕按下 → 讀到 LOW!' : '// 按住右下角的按鈕試試'}</span>
              </span>
              {'\n'}{'}'}
            </code>
          </pre>
        </div>
      </div>
    </div>
  );
};

/* ── Page ─────────────────────────────────────────────────────────────── */

export const BrandLandingPage: React.FC = () => {
  const { t } = useTranslation();
  const localize = useLocalizedHref();

  const revStats = useReveal<HTMLDivElement>();
  const revFeatures = useReveal<HTMLElement>();
  const revSteps = useReveal<HTMLElement>();
  const revAi = useReveal<HTMLElement>();
  const revTeacher = useReveal<HTMLElement>();

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
      <div className="brand-bg" aria-hidden>
        <div className="brand-aurora brand-aurora-a" />
        <div className="brand-aurora brand-aurora-b" />
        <div className="brand-grid" />
      </div>
      <AppHeader />

      {/* ── Hero ─────────────────────────────────────────── */}
      <section className="brand-hero">
        <div className="brand-hero-copy">
          <div className="brand-hero-badge">
            <span className="brand-hero-badge-dot" />
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
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 10h11M11 5.5 15.5 10 11 14.5" />
              </svg>
            </Link>
            <Link to={localize('/editor')} className="brand-cta brand-cta-secondary">
              {t('brand.hero.ctaEditor', '進入實驗室')}
            </Link>
          </div>
          <div className="brand-hero-boards">
            {BOARDS.map((b) => (
              <span key={b} className="brand-board-chip">{b}</span>
            ))}
          </div>
        </div>
        <LivingCircuit />
      </section>

      {/* ── Stats strip ──────────────────────────────────── */}
      <div className="brand-stats reveal" ref={revStats}>
        {[
          ['19', t('brand.stats.boards', '種開發板')],
          ['100+', t('brand.stats.parts', '個電子元件')],
          ['17', t('brand.stats.lessons', '堂互動課程')],
          ['62', t('brand.stats.quizzes', '道測驗題目')],
        ].map(([n, label]) => (
          <div key={label as string} className="brand-stat">
            <strong>{n}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>

      {/* ── Three pillars ────────────────────────────────── */}
      <section className="brand-features reveal" ref={revFeatures}>
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

      {/* ── Learning flow ────────────────────────────────── */}
      <section className="brand-steps reveal" ref={revSteps}>
        <h2>{t('brand.steps.title', '一堂課,四個步驟')}</h2>
        <div className="brand-steps-track">
          <div className="brand-steps-wire" aria-hidden>
            <span className="brand-steps-pulse" />
          </div>
          {[
            ['01', t('brand.steps.s1', '讀原理'), t('brand.steps.s1d', '白話講解,一次一個觀念')],
            ['02', t('brand.steps.s2', '開電路'), t('brand.steps.s2d', '一鍵載入本課範例電路')],
            ['03', t('brand.steps.s3', '跑模擬'), t('brand.steps.s3d', '按下執行,看它動起來')],
            ['04', t('brand.steps.s4', '做測驗'), t('brand.steps.s4d', '即時對錯回饋與計分')],
          ].map(([n, title, desc]) => (
            <div key={n as string} className="brand-step">
              <span className="brand-step-num">{n}</span>
              <strong>{title}</strong>
              <p>{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── AI assistant ─────────────────────────────────── */}
      <section className="brand-ai reveal" ref={revAi}>
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
            <span className="brand-chat-avatar">AI</span>
            {t(
              'brand.ai.demoAi',
              '我看了你的電路:LED 的陰極接到了 D13,應該接 GND 才能形成迴路。要我幫你改好並示範一次嗎?'
            )}
          </div>
          <div className="brand-chat-typing">
            <span /><span /><span />
          </div>
        </div>
      </section>

      {/* ── Teacher call-out ─────────────────────────────── */}
      <section className="brand-teacher reveal" ref={revTeacher}>
        <div className="brand-teacher-inner">
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
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────── */}
      <footer className="brand-footer">
        <span>{t('brand.name', 'AI物聯網實驗室')}</span>
        <span className="brand-footer-sep">·</span>
        <span>{t('brand.footer.oss', '開源軟體(AGPLv3 授權)')}</span>
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
