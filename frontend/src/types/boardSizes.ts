/**
 * Board visual dimensions (width × height in canvas px), shared by the
 * canvas drag overlay, the minimap, and the agent's collision safety net.
 * Standalone module (no DOM imports) so node-side code can use it.
 */

// Board visual dimensions (width × height) for the drag-overlay sizing.
// ESP32 sizes match the wokwi-boards SVG rendered at 5 px/mm.
export const BOARD_SIZE: Record<string, { w: number; h: number }> = {
  // wokwi-elements: rendered at 96 dpi — 1mm = 3.7795px
  'arduino-uno': { w: 274, h: 202 }, // 72.58mm × 53.34mm
  'arduino-nano': { w: 170, h: 67 }, // 44.9mm  × 17.8mm
  'arduino-mega': { w: 388, h: 192 }, // 102.66mm × 50.80mm
  // Pi Pico physical board is 51mm × 21mm vertical-narrow. The render
  // uses velxio's <velxio-pi-pico-w>, same Web Component as 'pi-pico-w'
  // because the Pico and Pico W are pin-compatible. Used to render the
  // wokwi-nano-rp2040-connect (168×68) — that was a completely different
  // board with D2-D13 pin labels, so wires in pico examples that
  // referenced GP10/GP18/etc. landed at (0,0). The render now matches
  // the boardKind name.
  'raspberry-pi-pico': { w: 105, h: 264 },
  'raspberry-pi-3': { w: 250, h: 160 }, // RaspberryPi3Element: PI_WIDTH=250 PI_HEIGHT=160
  'raspberry-pi-4': { w: 330, h: 215 }, // RaspberryPi4Element — real board photo (925×602 @ scale)
  'raspberry-pi-5': { w: 330, h: 220 }, // RaspberryPi5Element — real board photo (1024×681 @ scale)
  esp32: { w: 141, h: 265 }, // esp32-devkit-v1: 28.2 × 53 mm
  'esp32-s3': { w: 128, h: 350 }, // esp32-s3-devkitc-1: 25.5 × 70 mm
  'esp32-c3': { w: 127, h: 215 }, // esp32-c3-devkitm-1: 25.4 × 42.9 mm
  'pi-pico-w': { w: 105, h: 264 },
  'esp32-devkit-c-v4': { w: 140, h: 283 },
  'esp32-cam': { w: 136, h: 202 },
  'wemos-lolin32-lite': { w: 128, h: 250 },
  'xiao-esp32-s3': { w: 91, h: 117 },
  'arduino-nano-esp32': { w: 217, h: 90 },
  'xiao-esp32-c3': { w: 91, h: 117 },
  'aitewinrobot-esp32c3-supermini': { w: 90, h: 123 },
  'stm32-bluepill': { w: 114, h: 271 }, // 22.855 × 54.193 mm (wokwi-boards SVG)
  'stm32-blackpill': { w: 103, h: 266 }, // 20.695 × 53.125 mm (wokwi-boards SVG)
  'stm32-bluepill-f103cb': { w: 114, h: 271 }, // reuses Blue Pill SVG
  'stm32-blackpill-f401': { w: 103, h: 266 }, // reuses Black Pill SVG
  // Inline-rendered boards — sizes match Stm32BoardElement.inlineConfig()
  // (INLINE_W=158; h = 24 + rows*13 + 16).
  'stm32-f4-discovery': { w: 158, h: 235 }, // 15 rows per side
  'stm32-olimex-h405': { w: 158, h: 196 }, // 12 rows per side
  'stm32-netduino-plus2': { w: 158, h: 196 }, // 12 rows per side
  'stm32-netduino2': { w: 158, h: 196 }, // 12 rows per side
  attiny85: { w: 160, h: 132 },
};
