# 01 — Phase 1: boot + blink + Serial.println

Goal de Phase 1: que el `merged.bin` que ya genera `arduino-cli` arranque en QEMU, llame a `setup()`, `pinMode(2, OUTPUT)`, y vuelque "ESP32-P4 blink starting" + "HIGH/LOW" sobre UART0.

**Crítico**: NO emular nada del SoC que no sea estrictamente necesario para boot + GPIO + UART + delay. Stubs `qemu_log_unimp()` para todo lo demás.

## 1. Fork inicial

```bash
cd third-party/   # o crear wokwi-libs/qemu-esp32p4/
git clone --depth 1 -b esp-develop https://github.com/espressif/qemu.git qemu-esp32p4
cd qemu-esp32p4
git checkout -b feat/esp32p4-machine
```

Branch base: **`esp-develop`** (no `master`) — es la rama con los patches Espressif aplicados.

## 2. Build local del C3 primero (sanity check)

Antes de tocar nada, verificar que el build funciona:

```bash
./configure --target-list=riscv32-softmmu \
            --disable-werror \
            --disable-docs \
            --disable-gtk \
            --disable-vnc \
            --disable-sdl \
            --enable-debug
ninja -C build qemu-system-riscv32
./build/qemu-system-riscv32 -M esp32c3 -nographic
```

Si compila y arranca C3 → entorno ok. Si no → arreglar antes de intentar P4.

## 3. Memory map del P4 (TRM Cap. 7)

Direcciones críticas (extraer del TRM al iniciar; estos son rangos típicos de la familia):

| Región | Base | Tamaño | Notas |
|---|---|---|---|
| ROM (boot ROM Espressif) | `0x4FC00000` | ~256 KB | hay que extraer de un chip real o usar el de `pc-bios/` |
| HP SRAM (L2MEM) | `0x4FF00000` | 768 KB | accesible como cache + código + datos |
| TCM RAM | `0x40800000` | 8 KB | zero-wait |
| Cache MMU window (PSRAM/Flash) | `0x40000000` (instr), `0x48000000` (data) | hasta 32 MB | XIP via cache |
| Peripheral DR_REG | `0x500_0000`–`0x5FF_FFFF` | depende del peripheral | mismo patrón que C3/S3 |

**Acción**: leer Cap. 7.3 del TRM y volcar la tabla completa en `02_memory_map.md`.

## 4. Scope de peripherals para Phase 1

| # | Peripheral | Por qué se necesita | Archivos QEMU a crear/copiar |
|---|---|---|---|
| 1 | **HP CPU core 0** (RV32IMAFC + Zb + Zc) | ejecuta el sketch | reusar `target/riscv/` upstream + posibles custom CSRs (HW loop) |
| 2 | **Memory regions** | irom/drom/iram/dram según memmap | `hw/riscv/esp32p4.c::esp32p4_machine_init()` |
| 3 | **Reset + Clock** (subset) | bootloader primero deshabilita WDT, luego configura PLL | `hw/riscv/esp32p4_clk.c` (mínimo: PLL_FREQ ≈ 400 MHz, XTAL=40 MHz) |
| 4 | **CLIC + CLINT** | interrupts arquitectónicas RV | upstream QEMU tiene CLINT; CLIC posiblemente faltante para P4 (verificar) |
| 5 | **Interrupt Matrix (PERI→CLIC)** | route peripheral IRQ lines | `hw/riscv/esp32p4_intmatrix.c` |
| 6 | **Watchdog (RTC + TIMG)** | hay que poder feed/disable o el reset es infinito | `hw/watchdog/esp32p4_wdt.c` (stub: aceptar writes, ignorar) |
| 7 | **eFuse** (read-only stub) | boot ROM lee CHIP_ID, MAC, package version | `hw/nvram/esp32p4_efuse.c` (stub con valores de un chip real) |
| 8 | **System Timer (SYSTIMER)** | `delay()` y `millis()` | `hw/timer/esp32p4_systimer.c` |
| 9 | **GPIO Matrix + IO MUX** | `digitalWrite()`, `pinMode()` | `hw/gpio/esp32p4_gpio.c` |
| 10 | **UART0** | `Serial.println` | `hw/char/esp32p4_uart.c` (chardev sobre TCP, igual que C3) |
| 11 | **USB Serial/JTAG (Cap 51)** | Arduino default uses USB CDC for Serial when `CDCOnBoot=cdc` | nice-to-have Phase 1, mandatory Phase 2 |

**No tocar en Phase 1**: AES/SHA/RSA/HMAC/ECC, DMA, USB OTG, Ethernet, MIPI, ISP, JPEG, ADC, I2C, SPI, I2S, LEDC, MCPWM, Touch, Temp sensor, RNG, RTC, BitScrambler.

Estrategia para esos: crear `hw/misc/esp32p4_unimp.c` que registra una `MemoryRegion` por base del peripheral, retorna 0 en lecturas y log warning en escrituras. Así el bootloader/IDF arranca sin colgarse.

## 5. Cambios en `hw/riscv/`

Archivos nuevos:
- `esp32p4.c` — derivado de `esp32c3.c`. Renombrar `Esp32C3MachineState` → `Esp32P4MachineState`, ajustar `memmap[]`, instanciar peripherals según tabla §4.
- `esp32p4_clk.c` / `.h` — derivar de `esp32c3_clk.c`. PLL targets distintos.
- `esp32p4_intmatrix.c` / `.h` — verificar si P4 conserva el "interrupt matrix" o usa CLIC directo (TRM Cap 12 dice que sí hay matrix).

Archivos a modificar:
- `meson.build` — agregar `'esp32p4.c', 'esp32p4_clk.c', 'esp32p4_intmatrix.c'` cuando `CONFIG_ESP32P4`.
- `Kconfig` — `config ESP32P4 bool select RISCV32_CPU select ESP32P4_PERIPHS`.

## 6. Validación

### Smoke 1: ROM boot loop
QEMU arranca sin firmware. Output esperado: el bootloader stage 0 inmediatamente intenta leer flash y logea por UART. Mensaje "ESP-ROM:..." debería aparecer.

### Smoke 2: Stage 2 bootloader corre
Cargar `merged.bin` (4 MB con `boot+partitions+app`) vía:
```bash
qemu-system-riscv32 -M esp32p4 -drive file=merged.bin,if=mtd,format=raw -nographic
```
Output esperado: log de Espressif "rst:0x1 (POWERON_RESET), boot:..." en UART. Boot ROM → bootloader → partition table.

### Smoke 3: setup() ejecuta
El log debería mostrar el `Serial.println("ESP32-P4 blink starting")` del sketch.

### Smoke 4: GPIO toggle visible
Activar trace en GPIO writes (`-d unimp,trace:esp32p4_gpio_*`). Verificar que cada `digitalWrite(2, HIGH)` provoca write a `GPIO_OUT_W1TS_REG` con bit 2 seteado.

## 7. Integración Velxio (después de Smoke 3)

`backend/app/services/esp_qemu_manager.py`:
```python
_MACHINE: dict[str, tuple[str, str]] = {
    'esp32':    (QEMU_XTENSA,  'esp32'),
    'esp32-s3': (QEMU_XTENSA,  'esp32s3'),
    'esp32-c3': (QEMU_RISCV32, 'esp32c3'),
    'esp32-p4': (QEMU_RISCV32_P4, 'esp32p4'),  # binary del fork nuevo
}
QEMU_RISCV32_P4 = os.environ.get('QEMU_RISCV32_P4_BINARY', QEMU_RISCV32)
```

Bootloader offset: 0x2000 en P4 (¡ojo!, no 0x0000 ni 0x1000 — verificar `flash_args` que produce `arduino-cli`).

`frontend/src/types/board.ts`: agregar `'esp32-p4'`. `boardPinMapping.ts`: 55 pines según datasheet.

## 8. Cuándo Phase 1 está hecho

✅ Compilamos blink con `arduino-cli compile --fqbn esp32:esp32:esp32p4`
✅ Lanzamos `qemu-system-riscv32 -M esp32p4 -drive file=merged.bin,if=mtd -nographic`
✅ Vemos "ESP32-P4 blink starting" + "HIGH" + "LOW" alternándose cada 500 ms en stdout
✅ Velxio dropdown muestra "ESP32-P4" → click Run → mismo output en Serial Monitor

## Referencias

- `../specs/esp32-p4_technical_reference_manual_en.pdf` — fuente única de verdad para memory map y registros
- `../specs/_TRM_TOC.txt` — índice del TRM (1713 entradas)
- `https://github.com/espressif/qemu/blob/esp-develop/hw/riscv/esp32c3.c` — template
- `https://github.com/espressif/qemu/issues/127` — issue oficial pidiendo P4 support
- `https://www.qemu.org/docs/master/devel/qom.html` — QEMU Object Model (necesario para device hierarchy)
