# 00 — Decisión de approach: ¿cómo emular el ESP32-P4?

## Las 4 opciones reales

| Opción | Lenguaje | Esfuerzo Phase 1 (boot + blink + Serial) | Esfuerzo total | Integra a Velxio | Veredicto |
|---|---|---|---|---|---|
| **A**. Forkear `espressif/qemu`, agregar `hw/riscv/esp32p4.c` | C | **3-6 semanas** | 3-6 meses | 1 línea en `esp_qemu_manager.py` | ✅ **GANADOR** |
| B. Modificar `lcgamboa/qemu` | C | 4-7 semanas | 4-7 meses | 1 línea | ❌ peor que A |
| C. Modificar rvemu / riscv-rust / TinyEMU | Rust → WASM | 2-3 meses | 12-18 meses | reescribir bridge | ❌ |
| D. Escribir desde cero estilo `avr8js`/`rp2040js` | TS | 6-12 meses | 2-4 años | nativo browser | ❌ |

## Por qué A (forkear `espressif/qemu`) gana, sin discusión

1. **El CPU ya está hecho y bien.** QEMU upstream emula RV32IMAFC + Zb + A perfectamente. Toda la complejidad del decoder, pipeline, MMU, exceptions, atomics — ya resuelta. **No tiene sentido reimplementar lo más difícil**.

2. **Velxio ya integra QEMU.** El backend (`backend/app/services/esp_qemu_manager.py:41`) corre `qemu-system-riscv32 -M esp32c3` para ESP32-C3. Sumar P4 es:
   ```python
   _MACHINE: dict[str, tuple[str, str]] = {
       'esp32-c3': (QEMU_RISCV32, 'esp32c3'),
       'esp32-p4': (QEMU_RISCV32, 'esp32p4'),  # ← una línea
   }
   ```
   Cero infraestructura nueva. UART, GPIO chardev, hot-reload de firmware, WebSocket bridge — todo gratis.

3. **`esp32c3.c` es un template casi listo.** Verificado:
   - 691 líneas de C en el machine file principal.
   - Pattern muy mecánico: declarar memory regions (irom, drom, iram, dram, rtcram), mapear peripherals a `DR_REG_*` addresses, wire interrupts, instanciar UART/GPIO/SPI/I2C/RNG/AES/SHA/HMAC/RSA/RTC.
   - **AES, SHA, RSA, HMAC, eFuse**: mismo IP block en C3 y P4 → reutilizables casi tal cual.
   - **GPIO, UART, SPI, I2C, LEDC, Timer Group**: mismo IP, distinta cantidad/direcciones → adaptar memory map.

4. **Compilable a WASM.** El mismo fork QEMU se puede compilar con Emscripten (ya hay precedente en `test/esp32-emulator/qemu-wasm/Dockerfile` para Xtensa). Si en el futuro queremos correr P4 100% en browser, el path está abierto.

5. **Upstreamable.** Espressif tiene [issue #127](https://github.com/espressif/qemu/issues/127) explícitamente pidiendo este soporte. Tu fork puede convertirse en su contribución oficial. Mantenimiento futuro = de ellos.

## Por qué descartar las otras

### B. Forkear `lcgamboa/qemu`

`lcgamboa/qemu` es un fork de `espressif/qemu` que agrega:
- Compilación como librería dinámica (para PICSimLab).
- WiFi y ESPNOW en `esp32_wifi` / `esp32c3_wifi` NIC models.

**El P4 no tiene radio nativa** (depende de un ESP32-C6 externo por SDIO). Las patches de WiFi de lcgamboa **no aportan nada** al P4. Forkear desde `lcgamboa` te hereda divergencia con upstream sin beneficio. Veredicto: forkear directo `espressif/qemu`.

### C. rvemu / riscv-rust / TinyEMU

| Proyecto | Lo que da | Lo que falta para P4 |
|---|---|---|
| `d0iasm/rvemu` (Rust→WASM) | RV64GC, Sv39, virtio devices | swap **TODO** el device model. ~80% del trabajo de QEMU. |
| `takahirox/riscv-rust` (Rust→WASM) | RV64IMAFD | idem. |
| `TinyEMU` (Bellard, C→WASM) | RV32IMA + RV64GC, virtio | idem. |

El CPU se obtiene gratis igual que QEMU, **pero las peripherals — que son el 80% del trabajo — hay que escribirlas igual**. Y encima:
- Pierdes la madurez de QEMU (caches, debug, GDB stub, plugins).
- Sumás el costo de integrar Rust+WASM al pipeline TS de Velxio.

No hay ahorro real.

### D. Desde cero TS estilo avr8js/rp2040js

| Comparación | avr8js | rp2040js | esp32p4 |
|---|---|---|---|
| ISA | AVR 8-bit, 131 instrucciones | ARMv6-M Cortex-M0+, single-issue | RV32IMAFC + Zb + custom HW loop, dual-core HP + LP |
| Periféricos críticos | PORTB/C/D, ADC, Timer | GPIO, PIO, ADC, UART, SPI, I2C | 55 GPIO + matrix, UART×5, SPI×3, I2C×2, I2S×3, USB OTG HS/FS, ETH, SDIO, MIPI-CSI/DSI, ISP, JPEG, H264, AES, SHA, ECC, RSA, HMAC, RNG, ADC, LEDC, MCPWM, RMT, PCNT, TWAI, Touch... |
| LOC del emulador | ~5K | ~10K | estimado **50K-80K** sin MIPI/H264 |
| Tiempo estimado primera ejecución | 6 meses | 1-2 años (Wokwi reportó esto) | **3-5 años** para 1 persona |

Reescribir QEMU en TypeScript es académicamente interesante y prácticamente irrelevante. Out.

## Roadmap recomendado (Phase 1: blink + Serial.println)

Ver `01_phase1_plan.md` para detalle. Resumen:

| # | Tarea | Effort | Capítulo TRM |
|---|---|---|---|
| 1 | Fork `espressif/qemu` rama `esp-develop`, crear branch `feat/esp32p4-machine` | 1h | — |
| 2 | Crear `hw/riscv/esp32p4.c` desde el template de `esp32c3.c` | 3 días | Ch 7 (memmap), Ch 11 (boot) |
| 3 | Implementar Reset + Clock subsystem mínimo | 2 días | Ch 10 |
| 4 | Implementar GPIO matrix + IO MUX | 4 días | Ch 9 |
| 5 | Implementar UART0 (chardev) | 2 días | Ch 42 |
| 6 | Implementar System Timer (para `delay()`) | 2 días | Ch 15 |
| 7 | Implementar CLIC + CLINT (estándar RISC-V; QEMU tiene base) | 3 días | Ch 1.9, Ch 12 |
| 8 | Implementar Watchdog (para que el bootloader no se cuelgue) | 1 día | Ch 17 |
| 9 | Implementar eFuse stub (boot necesita leer chip ID) | 2 días | Ch 8 |
| 10 | Compilar, ejecutar `merged.bin` de Arduino, verificar `Serial.println` aparece en UART0 | 2 días | — |
| 11 | Wire en Velxio: `_MACHINE['esp32-p4']`, board element, pin map | 1 día | — |

**Total Phase 1: ~22 días-persona** (3-6 semanas a tiempo parcial). Phases 2 y 3 quedan para otro plan.

## Decisión final

**Path A: forkear `espressif/qemu`** y agregar `hw/riscv/esp32p4.c` modelado sobre `esp32c3.c`.

Próximos pasos concretos en [`01_phase1_plan.md`](01_phase1_plan.md).

## Material de referencia descargado en `../specs/`

- `esp32-p4_technical_reference_manual_en.pdf` — 21 MB, 3078 páginas, 63 capítulos. Index completo en `_TRM_TOC.txt`.
- `esp32-p4_datasheet_en.pdf` — 1.5 MB.
- `esp32-p4_hardware_design_guidelines_en.pdf` — 1.8 MB.
