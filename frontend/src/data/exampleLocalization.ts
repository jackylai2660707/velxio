import type { ExampleProject } from './examples';

export interface LocalizedExample {
  title: string;
  description: string;
  overview: string;
  goals: string[];
}

const ZH_OVERRIDES: Record<string, { title: string; description: string }> = {
  'fade-led': { title: 'LED 漸變呼吸燈', description: '使用 PWM 讓 LED 緩慢變亮與變暗，理解占空比、亮度和時間控制。' },
  'binary-counter-leds': { title: 'LED 二進位計數器', description: '用多顆 LED 顯示二進位計數，學習位元運算、迴圈與數位輸出。' },
  'voltage-divider': { title: '電阻分壓器', description: '用兩個電阻把 5V 分成較低電壓，再由類比輸入讀取分壓結果。' },
  'rc-low-pass-filter': { title: 'RC 低通濾波器', description: '用電阻與電容將 PWM 平滑成類比電壓，觀察濾波器的充放電效果。' },
  'uno-oled-4pin-i2c': { title: 'Arduino Uno：SSD1306 OLED I²C 顯示器', description: '透過 I²C 連接四線 OLED，顯示文字與即時計數器。' },
  'esp32-oled-4pin-i2c': { title: 'ESP32：SSD1306 OLED I²C 顯示器', description: '使用 ESP32 的 I²C 腳位驅動 OLED，顯示文字與即時資料。' },
  'button-led': { title: '按鈕控制 LED', description: '按下按鈕時點亮 LED，練習 INPUT_PULLUP、數位輸入與輸出控制。' },
};

const WORDS: Array<[RegExp, string]> = [
  [/\bvoltage divider\b/gi, '電壓分壓器'], [/\blow-pass filter\b/gi, '低通濾波器'], [/\btemperature\b/gi, '溫度'],
  [/\bdistance\b/gi, '距離'], [/\bsensors?\b/gi, '感測器'], [/\bdisplays?\b/gi, '顯示器'], [/\bcounters?\b/gi, '計數器'],
  [/\bbuttons?\b/gi, '按鈕'], [/\bmotors?\b/gi, '馬達'], [/\bservos?\b/gi, '伺服馬達'], [/\btraffic lights?\b/gi, '交通號誌'],
  [/\bblinks?\b/gi, '閃爍'], [/\bleds?\b/gi, 'LED'], [/\bpwm\b/gi, 'PWM'], [/\bi2c\b/gi, 'I²C'], [/\bwifi\b/gi, 'Wi‑Fi'],
];

function zhTitle(example: ExampleProject): string {
  const override = ZH_OVERRIDES[example.id];
  if (override) return override.title;
  const translated = WORDS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), example.title);
  return translated === example.title ? `實作範例：${example.title}` : translated;
}

function zhDescription(example: ExampleProject): string {
  const override = ZH_OVERRIDES[example.id];
  if (override) return override.description;
  const parts = (example.components ?? []).filter((c) => !/arduino|esp32|pico|board/i.test(c.type)).slice(0, 4).map((c) => c.type.replace(/^wokwi-/, '')).join('、');
  const title = zhTitle(example);
  return `這個範例示範「${title}」，可在瀏覽器中執行電路，觀察${parts ? ` ${parts} 元件的` : ''}實際反應，再逐步修改程式與接線。`;
}

export function localizeExample(example: ExampleProject, locale: string): LocalizedExample {
  if (!locale.toLowerCase().startsWith('zh')) {
    return { title: example.title, description: example.description, overview: `Build and run ${example.title} in the browser, then change one value at a time.`, goals: ['Run the simulation and observe the output.', 'Read the wiring and source code.', 'Make one safe change and compare the result.'] };
  }
  const title = zhTitle(example);
  return { title, description: zhDescription(example), overview: `透過「${title}」學習完整的物聯網電路流程：先執行、再閱讀接線與程式，最後一次修改一個部分。`, goals: ['執行仿真並觀察元件的實際反應。', '對照接線圖閱讀程式與腳位。', '安全地修改一個數值或接線，再比較結果。'] };
}

export function localizedBoardLabel(key: string, locale: string, fallback: string): string {
  if (!locale.toLowerCase().startsWith('zh')) return fallback;
  const labels: Record<string, string> = { all: '全部開發板', retro: '復古／經典', 'arduino-uno': 'Arduino Uno', 'arduino-nano': 'Arduino Nano', 'arduino-mega': 'Arduino Mega', 'raspberry-pi-pico': 'Raspberry Pi Pico', 'pi-pico-w': 'Pico W（Wi‑Fi）', esp32: 'ESP32', 'esp32-cam': 'ESP32-CAM', 'esp32-s3': 'ESP32-S3', 'esp32-c3': 'ESP32-C3', multi: '多開發板', analog: '類比電路', digital: '數位電路' };
  return labels[key] ?? fallback;
}
