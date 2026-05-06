# test-esp32-p4 — investigación de soporte ESP32-P4 en Velxio

Sandbox de investigación para evaluar si el chip Espressif **ESP32-P4** puede sumarse a Velxio como board emulable.

## Contexto

Velxio hoy tiene **dos vías** de emulación:

1. **Frontend (browser)** — JS puro / WASM. Cubre AVR (`avr8js`) y RP2040 (`rp2040js`).
2. **Backend WebSocket → QEMU** — proceso QEMU por cliente, UART y GPIO chardev sobre TCP. Cubre ESP32, ESP32-S3 (Xtensa) y ESP32-C3 (RISC-V).

Ver `backend/app/services/esp_qemu_manager.py` para el pattern actual.

## Estructura

```
test-esp32-p4/
├── README.md                  # este archivo
├── autosearch/                # investigación inicial: ¿se puede hoy? → no
│   ├── 01_findings.md
│   ├── 02_chip_overview.md
│   ├── 03_compilation_test.md
│   ├── 04_qemu_backend_path.md
│   ├── 05_frontend_emulation_path.md
│   └── 06_recommendations.md
├── emulator/                  # decisión y plan para BUILDEAR el emulador
│   ├── README.md
│   ├── 00_approach_decision.md   # los 4 paths comparados, ganador, rationale
│   └── 01_phase1_plan.md         # plan accionable: boot + blink + Serial
├── specs/                     # documentación oficial Espressif
│   ├── esp32-p4_technical_reference_manual_en.pdf (21 MB, 3078 pg)
│   ├── esp32-p4_datasheet_en.pdf
│   ├── esp32-p4_hardware_design_guidelines_en.pdf
│   └── _TRM_TOC.txt           # index del TRM para grep
├── sketches/blink/blink.ino   # sketch mínimo Arduino para esp32:esp32:esp32p4
└── scripts/
    ├── compile.sh
    └── smoke_qemu.sh
```

## TL;DR

- ✅ **Compilación funciona** con `arduino-cli` + core `esp32:esp32 3.3.8`. FQBN `esp32:esp32:esp32p4` produce ELF RISC-V 32-bit (RVC, single-float ABI) y `merged.bin` de 4 MB.
- ❌ **No hay máquina QEMU para ESP32-P4** en `espressif/qemu` (último release `esp-develop-9.2.2-20260417`). Soporte es "To Do" — ver [issue #127](https://github.com/espressif/qemu/issues/127).
- ❌ **No hay emulador JS/WASM open-source** del ESP32-P4. Wokwi tiene simulador beta cerrado (`board-esp32-p4-preview`); su engine no es público.
- ✅ **Decisión de approach**: forkear `espressif/qemu` y agregar `hw/riscv/esp32p4.c` modelado sobre `esp32c3.c`. Detalle del porqué (vs JS-from-scratch / TinyEMU / lcgamboa) en [`emulator/00_approach_decision.md`](emulator/00_approach_decision.md). Plan accionable Phase 1 en [`emulator/01_phase1_plan.md`](emulator/01_phase1_plan.md).

## Reproducir el test de compilación

```bash
cd test/test-esp32-p4/sketches
arduino-cli core install esp32:esp32  # si no está instalado
arduino-cli compile --fqbn esp32:esp32:esp32p4 blink
ls blink/build/esp32.esp32.esp32p4/
# blink.ino.elf, blink.ino.bin, blink.ino.merged.bin (4 MB), bootloader, partitions
file blink/build/esp32.esp32.esp32p4/blink.ino.elf
# → ELF 32-bit LSB executable, UCB RISC-V, RVC, single-float ABI
```
