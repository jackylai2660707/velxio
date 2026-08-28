/**
 * ExampleDetailPage — SEO landing page for a single example.
 *
 * Route: /examples/:exampleId
 *
 * Shows example title, description, category, difficulty and board type with
 * a CTA to open the example in the simulator.  Fully prerenderable at build
 * time (no browser-only APIs on first render) so every example gets its own
 * statically-served HTML for search engines.
 */

import React from 'react';
import { useState, useSyncExternalStore } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { exampleProjects, subscribeProExamples, getProExamplesVersion } from '../data/examples';
import { AppHeader } from '../components/layout/AppHeader';
import { ExampleThumbnail } from '../components/examples/ExampleThumbnail';
import { useSEO } from '../utils/useSEO';

// Relative canonical/JSON-LD URLs — this deployment has no fixed domain.
const DOMAIN = '';

const BOARD_LABELS: Record<string, string> = {
  'arduino-uno': 'Arduino Uno',
  'arduino-nano': 'Arduino Nano',
  'arduino-mega': 'Arduino Mega',
  'raspberry-pi-pico': 'Raspberry Pi Pico (RP2040)',
  esp32: 'ESP32',
  'esp32-s3': 'ESP32-S3',
  'esp32-c3': 'ESP32-C3',
};

const CATEGORY_LABELS: Record<string, string> = {
  basics: 'Basics',
  sensors: 'Sensors',
  displays: 'Displays',
  communication: 'Communication',
  games: 'Games',
  robotics: 'Robotics',
};

const DIFFICULTY_COLOR: Record<string, string> = {
  beginner: '#4caf50',
  intermediate: '#ff9800',
  advanced: '#f44336',
};

export const ExampleDetailPage: React.FC = () => {
  // Re-render when the pro overlay registers late examples (dynamic import).
  useSyncExternalStore(subscribeProExamples, getProExamplesVersion, getProExamplesVersion);

  const { exampleId } = useParams<{ exampleId: string }>();
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const example = exampleId ? exampleProjects.find((e) => e.id === exampleId) : null;

  // SEO — called unconditionally (hooks must not be inside conditionals).
  const seoTitle = example
    ? `${example.title} — 電路範例 — AI物聯網實驗室`
    : '找不到範例 — AI物聯網實驗室';

  // Older examples use boardFilter/boards instead of boardType. Prefer the
  // explicit boardType, then derive from the filter or first board so the
  // detail badge never silently falls back to Arduino Uno (notably ESP32
  // OLED and Pico examples).
  const boardKey = example
    ? (example.boardType ?? example.boardFilter ?? example.boards?.[0]?.boardKind ?? 'arduino-uno')
    : '';
  const boardLabel = example
    ? (BOARD_LABELS[boardKey] ?? boardKey)
    : '';

  const seoDescription = example
    ? `${example.description}. Run this ${boardLabel} example free in your browser — no install, no account required.`
    : 'This example was not found.';

  useSEO({
    title: seoTitle,
    description: seoDescription,
    url: `${DOMAIN}/examples/${exampleId ?? ''}`,
  });

  const handleOpen = () => {
    if (!example) return;
    setConfirmOpen(true);
  };

  const applyExample = () => {
    if (!example) return;
    setConfirmOpen(false);
    navigate(`/example/${example.id}`);
  };

  // ── 404 state ───────────────────────────────────────────────────────────────
  if (!example) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: '100vh',
          background: '#1e1e1e',
        }}
      >
        <AppHeader />
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
          }}
        >
          <div style={{ fontSize: 48, color: '#555' }}>404</div>
          <div style={{ fontSize: 16, color: '#999' }}>Example "{exampleId}" not found.</div>
          <Link
            to="/examples"
            style={{
              color: '#4fc3f7',
              textDecoration: 'none',
              border: '1px solid #4fc3f7',
              borderRadius: 4,
              padding: '8px 20px',
              fontSize: 14,
            }}
          >
            Browse all examples
          </Link>
        </div>
      </div>
    );
  }

  const diffColor = DIFFICULTY_COLOR[example.difficulty] ?? '#999';
  const categoryLabel = CATEGORY_LABELS[example.category] ?? example.category;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        background: '#1e1e1e',
      }}
    >
      <AppHeader />

      <main
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '48px 24px 80px',
        }}
      >
        {/* Breadcrumb */}
        <nav
          style={{ width: '100%', maxWidth: 760, marginBottom: 32, fontSize: 13, color: '#666' }}
        >
          <Link to="/" style={{ color: '#666', textDecoration: 'none' }}>
            AI物聯網實驗室
          </Link>
          {' / '}
          <Link to="/examples" style={{ color: '#666', textDecoration: 'none' }}>
            Examples
          </Link>
          {' / '}
          <span style={{ color: '#aaa' }}>{example.title}</span>
        </nav>

        {/* Card */}
        <article
          style={{
            width: '100%',
            maxWidth: 760,
            background: '#252526',
            border: '1px solid #333',
            borderRadius: 12,
            padding: '40px 48px',
          }}
        >
          {/* Circuit preview */}
          <div
            style={{
              width: '100%',
              borderRadius: 8,
              overflow: 'hidden',
              marginBottom: 28,
              border: '1px solid #333',
            }}
          >
            <ExampleThumbnail
              example={example}
              width={760}
              height={240}
              background="#111"
              style={{ width: '100%', height: 240, borderRadius: 7 }}
            />
          </div>

          {/* Badges */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                padding: '3px 10px',
                borderRadius: 4,
                background: '#1a3a4a',
                color: '#4fc3f7',
              }}
            >
              {categoryLabel}
            </span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                padding: '3px 10px',
                borderRadius: 4,
                background: `${diffColor}22`,
                color: diffColor,
              }}
            >
              {example.difficulty}
            </span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                padding: '3px 10px',
                borderRadius: 4,
                background: '#2a2a2a',
                color: '#aaa',
              }}
            >
              {boardLabel}
            </span>
          </div>

          {/* Title */}
          <h1
            style={{
              fontSize: 28,
              fontWeight: 700,
              color: '#d4d4d4',
              margin: '0 0 16px',
              lineHeight: 1.3,
            }}
          >
            {example.title}
          </h1>

          {/* Description */}
          <p style={{ fontSize: 16, color: '#9d9d9d', lineHeight: 1.7, margin: '0 0 32px' }}>
            {example.description}
          </p>

          <section style={{ marginBottom: 32, padding: '18px 20px', background: '#202b33', border: '1px solid #314552', borderRadius: 8 }}>
            <h2 style={{ margin: '0 0 12px', color: '#f0f6f8', fontSize: 15 }}>
              Project brief / 專案簡介
            </h2>
            <p style={{ margin: '0 0 10px', color: '#c7d5da', fontSize: 14, lineHeight: 1.65 }}>
              Learn by running a complete circuit, reading the source, and changing one part at a time.
              <br />透過完整電路開始學習：先執行、再閱讀程式，最後一次只修改一個部分。
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10, color: '#9fb5bd', fontSize: 13 }}>
              <div><strong style={{ color: '#69d0e8' }}>Board / 開發板</strong><br />{boardLabel}</div>
              <div><strong style={{ color: '#69d0e8' }}>Level / 難度</strong><br />{example.difficulty}</div>
              <div><strong style={{ color: '#69d0e8' }}>Parts / 元件</strong><br />{example.components?.length ?? 0} interactive parts / 個互動元件</div>
              <div><strong style={{ color: '#69d0e8' }}>Practice / 練習</strong><br />Run → observe → edit / 執行 → 觀察 → 修改</div>
            </div>
          </section>

          <section style={{ marginBottom: 36, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 14 }}>
            <div style={{ padding: '16px 18px', background: '#202020', border: '1px solid #353535', borderRadius: 8 }}>
              <h2 style={{ margin: '0 0 10px', color: '#e5eaec', fontSize: 14 }}>Circuit map / 接線摘要</h2>
              <p style={{ margin: '0 0 10px', color: '#8f9ba1', fontSize: 13, lineHeight: 1.55 }}>
                {example.wires?.length ?? 0} connections / 條接線 · {example.components?.length ?? 0} parts / 個元件
              </p>
              <ul style={{ margin: 0, paddingLeft: 18, color: '#b8c4c9', fontSize: 12, lineHeight: 1.65 }}>
                {(example.components ?? []).slice(0, 4).map((component) => <li key={component.id}>{component.type}</li>)}
                {(example.components?.length ?? 0) > 4 && <li>…and more / 以及其他元件</li>}
              </ul>
            </div>
            <div style={{ padding: '16px 18px', background: '#202020', border: '1px solid #353535', borderRadius: 8 }}>
              <h2 style={{ margin: '0 0 10px', color: '#e5eaec', fontSize: 14 }}>Try this / 動手試試</h2>
              <ol style={{ margin: 0, paddingLeft: 18, color: '#b8c4c9', fontSize: 12, lineHeight: 1.75 }}>
                <li>Run the project / 執行專案</li>
                <li>Watch Serial Monitor / 觀察序列埠</li>
                <li>Change one value or wire / 修改一個數值或接線</li>
                <li>Ask Agent to explain the result / 請 Agent 解釋結果</li>
              </ol>
            </div>
          </section>

          {/* What you'll learn section */}
          <section style={{ marginBottom: 36 }}>
            <h2
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: '#858585',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                margin: '0 0 12px',
              }}
            >
              What you'll simulate
            </h2>
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <li
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  color: '#c8c8c8',
                  fontSize: 14,
                }}
              >
                <span style={{ color: '#4fc3f7', fontWeight: 700 }}>✓</span>
                Real {boardLabel} emulation — cycle-accurate, no hardware needed
              </li>
              <li
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  color: '#c8c8c8',
                  fontSize: 14,
                }}
              >
                <span style={{ color: '#4fc3f7', fontWeight: 700 }}>✓</span>
                {(example.components?.length ?? 0) > 0
                  ? `${example.components.length} interactive component${example.components.length > 1 ? 's' : ''} on the canvas`
                  : 'Interactive simulation canvas'}
              </li>
              {example.libraries && example.libraries.length > 0 && (
                <li
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    color: '#c8c8c8',
                    fontSize: 14,
                  }}
                >
                  <span style={{ color: '#4fc3f7', fontWeight: 700 }}>✓</span>
                  Auto-installs: {example.libraries.join(', ')}
                </li>
              )}
              <li
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  color: '#c8c8c8',
                  fontSize: 14,
                }}
              >
                <span style={{ color: '#4fc3f7', fontWeight: 700 }}>✓</span>
                Serial Monitor included — see output in real time
              </li>
            </ul>
          </section>

          {/* CTA */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={handleOpen}
              style={{
                background: '#0e639c',
                border: 'none',
                borderRadius: 6,
                color: '#fff',
                fontSize: 15,
                fontWeight: 600,
                padding: '12px 28px',
                cursor: 'pointer',
                letterSpacing: '0.02em',
              }}
            >
              Open in Simulator
            </button>
            <Link to="/examples" style={{ color: '#666', textDecoration: 'none', fontSize: 14 }}>
              ← Back to examples
            </Link>
          </div>
        </article>

        {/* JSON-LD structured data */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'LearningResource',
              name: example.title,
              description: seoDescription,
              url: `${DOMAIN}/examples/${example.id}`,
              educationalLevel: example.difficulty,
              learningResourceType: 'Simulation',
              provider: { '@type': 'Organization', name: 'AI物聯網實驗室', url: DOMAIN },
              about: { '@type': 'Thing', name: boardLabel },
            }),
          }}
        />
      </main>

      {confirmOpen && (
        <div role="presentation" onClick={() => setConfirmOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'grid', placeItems: 'center', padding: 20, background: 'rgba(0,0,0,.72)' }}>
          <div role="dialog" aria-modal="true" aria-labelledby="apply-example-title" onClick={(event) => event.stopPropagation()} style={{ width: 'min(100%, 470px)', background: '#252526', border: '1px solid #46515a', borderRadius: 12, padding: 28, boxShadow: '0 24px 80px rgba(0,0,0,.5)' }}>
            <div style={{ color: '#69d0e8', fontSize: 12, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase' }}>Apply example / 套用範例</div>
            <h2 id="apply-example-title" style={{ color: '#f4f7f8', fontSize: 21, margin: '8px 0 12px' }}>{example.title}</h2>
            <p style={{ color: '#c3c8cb', lineHeight: 1.65, margin: '0 0 8px' }}>
              This will replace the current editor workspace.<br />套用後會取代目前工作區中的電路、接線與程式碼。
            </p>
            <p style={{ color: '#8f9ba1', fontSize: 13, margin: '0 0 22px' }}>
              Save or export your current project first if you want to keep it. / 如需保留目前專案，請先儲存或匯出。
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 10 }}>
              <button type="button" onClick={() => setConfirmOpen(false)} style={{ border: '1px solid #56616a', background: 'transparent', color: '#d8e0e3', borderRadius: 6, padding: '10px 16px', cursor: 'pointer', whiteSpace: 'nowrap' }}>Cancel / 取消</button>
              <button type="button" onClick={applyExample} autoFocus style={{ border: 0, background: '#0e88a8', color: '#fff', borderRadius: 6, padding: '10px 18px', cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap' }}>Apply and open / 套用並開啟</button>
            </div>
          </div>
        </div>
      )}

      {/* Library install overlay used to live here — moved to
          ExampleEditorPage now that loading runs at /example/<id>. */}
    </div>
  );
};
