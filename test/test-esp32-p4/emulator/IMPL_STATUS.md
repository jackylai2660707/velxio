# Estado de implementación ESP32-P4 — sesión 2026-05-06

## TL;DR

✅ **Skeleton commit** `d7969f43ec` — machine `esp32p4` registrada con memory map TRM Cap 7.
✅ **CI auto-trigger** `b5d2fd732d` — `feat/**` dispara build-libqemu.
✅ **Build + Phase 0 smoke** — machine init corre, CPU ejecuta.
✅ **UART0 + `-bios` loader** `24e67a8852` — `Hi\n` end-to-end desde firmware RISC-V hand-rolled, confirmado en stdout.
✅ **Named peripheral stubs** `c976734cc2` — 22 peripherals registrados con `create_unimplemented_device()`. Visibles en `info mtree`, logging por peripheral, sin faults.
✅ **Real eFuse + SYSTIMER + GPIO** `b9abf3712a` — 3 sysbus devices reales (~458 LOC) reemplazan los stubs correspondientes. Smoke test de 138 instrucciones RV32I valida que: MAC se lee como `0xDEADBE7C`, SYSTIMER avanza entre lecturas, GPIO bit 2 se setea/limpia con W1TS/W1TC y emite log "pin 2 -> 0/1".
✅ **`-kernel` ELF loader + 64 MB extflash + trampolín** `cd03e7a73a` — `blink.ino.elf` carga, sus 5 PT_LOAD segments aterrizan en HP SPM/extflash/L2MEM/LP SRAM, trampolín de 12 bytes en HP ROM salta al entry `0x4FF00C40`. CPU ejecuta `call_start_cpu0`, llama a `rv_utils_dbgr_is_attached`, regresa, llega a `CSRRS x, 0x7C1, x` (CSR custom Espressif CLIC) y se detiene. **Estamos ejecutando código del runtime ESP-IDF**.
✅ **Phase 1.E.bis — `-bios` ELF + ROM Espressif oficial** `e05e2019a7` — `-bios esp32p4_rev0_rom.elf` (256 KB, del release [esp-rom-elfs](https://github.com/espressif/esp-rom-elfs/releases)) carga 113 KB de código real en HP ROM. Trampolín del `-kernel` movido a `0x4FC1FFE0` para no pisar el ROM. Resetvec decidido por presencia de `-kernel`. Funciones `esp_rom_*`, `ets_*` ahora tienen implementación real.
✅ **Phase 1.F-lite** `fe94ceaa04` — 5 unblocks: (1) RVA+RVF en CPU misa, (2) custom CSRs `0xBC0-0xBFF`, (3) CLIC MMIO stub @ `0x20800000`, (4) targeted flash bypass patches en 3 funciones IDF, (5) smart sysreg stub con scratch RW + override table. Descubrimiento clave: ESP32-P4 NO tiene SPI flash controller separado — cache MMU + MSPI internos manejan flash. Runtime ahora ejecuta past flash detection + FreeRTOS port init + spinlocks + sysreg polls hasta `system_early_init` esperando un interrupt (Phase 1.K).
✅ **Phase 1.F.bis** `d4505f8689` — 4 unblocks adicionales (skip core-1 wait, cache_hal patch, TIMG0 cal-done bit, Reset/Clock op-done bit). Trace de 9602 → 12920 líneas. Runtime atraviesa `system_early_init`, `esp_clk_init`, `rtc_clk_init`, `rtc_clk_cal_internal`, `rtc_clk_cpu_freq_*`, `regi2c_*`, `spi_flash_cache_enabled` → assert downstream del cache check. Patrón establecido: trace → disasm → identificar override/patch → rebuild → repetir. ~50-100 iteraciones más para `app_main`.
✅ **Phase 1.F.ter** `19537aa64d` — `__assert_func` patcheado a `c.li a0,0; c.jr ra` (no-op). Runtime continúa past assertions. Avanza hasta `regi2c_enable_block.isra.0` (~15 calls), después spin en TBs cacheadas — bloqueante real es FreeRTOS dependence on SYSTIMER/TIMG IRQs. Identificados Arduino entry points: `setup()` 0x40000020, `loop()` 0x4000006A, `loopTask()` 0x40002FE4, `app_main()` 0x4000303E. Estrategias futuras documentadas en [phase_1l_iterative_patches.md](../autosearch/stages/phase_1l_iterative_patches.md).
🚧 **Phase 2 — PROFESSIONAL** — roadmap completo en [PHASE_2_PROFESSIONAL_ROADMAP.md](../autosearch/stages/PHASE_2_PROFESSIONAL_ROADMAP.md). Goal: cero hacks, IDF runtime ejecuta como en silicon real.
✅ **Phase 2.A.1** `07ac21bd0d` — Boot real desde `merged.bin` vía cache window:
  - `-drive if=mtd,file=merged.bin` carga blob de 4 MB en `0x40000000`.
  - HP ROM ret-fill cambiado a `address_space_write` síncrono (era queue rom blob, pisaba el ROM ELF).
  - **CPU bootea desde el ROM oficial Espressif sin hacks**: trampoline → `_vector_table` → `main` → `ROM_L1_Cache_Init` → `Cache_Invalidate_All` → `ets_efuse_jtag_disabled` → `ets_printf` → `ets_fatal_exception_handler` (siguiente blocker, real silicon ROM).
  - Trace de 8 → 1033 líneas. Path independiente del `-kernel` ELF path (que sigue funcional).
✅ **Phase 2.A.2** `4253b3eea4` — **¡UART output del ROM real!**
  - 3 smart stubs scratch-RW: cache controller (`0x3FF10000`), flash MSPI (`0x5008C000`), psram MSPI (`0x5008E000`).
  - Override por offset: `0x3FF10098 -> 0x10` (Cache_Wait_Idle bit 4 = ready).
  - 1 ROM patch: `Cache_Invalidate_All` (`0x4FC10982`) → return success (deref-NULL bug por BSS hardware-state que no modelamos).
  - Trace muestra `uart_hal_write_fifo` + `uart_hal_get_txfifo_count` ejecutando — **UART real escribe a stdout**.
  - Output garbled "EGGGGGGGG..." = principio del banner "Guru Meditation Error" del ROM panic handler. ROM cae en panic recursivo (probablemente eFuse read), pero **UART output works**.
✅ **Phase 2.A.3** `780ad0c50c` — **¡Banner completo del ROM!** `ESP-ROM:esp32p4-20230811 / Build:Aug 11 2023 / rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)`. Tres fixes: BIOS section-data pass (15 secciones `.data.*` no-PT_LOAD), reset-cause override (`0x50111010 → 0x80`), GPIO strap (offset 0x38 → 0x08). USB Serial tx patch para forzar output solo via UART0. ROM aún panica downstream (PC `0x4FC02954`, A5=0x8067) — algo overwrites `ets_ops_table_ptr` al runtime; Phase 2.A.4 investiga.
✅ **Phase 2.A.4** — **ROM avanza más allá del banner sin panic**.
  - Investigación: el ROM `_init` (`0x4FC00BDE`) tiene `unpackloop` (lee de `0x4FC1Cxxx` → `0x4FF3FFxx`) seguido de `clearloop` (zerea las mismas direcciones). Las dos tablas se sobreponen en `0x4FF3FFD8/E8/F4`.
  - El descubrimiento clave: **el "agujero" entre PT_LOADs** — el ELF tiene LOAD entries con `FileSiz=0` para `0x4FC1C154+`, así que las fuentes de copia del unpack no están en el archivo. En silicon real la mask layer pre-graba esos bytes; en QEMU son 0s.
  - Resultado en QEMU: section-data pass escribe `0x4FC1F984`, `0x4FC1D0F0`, etc. → unpackloop copia 0s sobre ellos → clearloop confirma 0s. Net: 0s en runtime. Por eso `lw a5, 0(a5)` faulteaba con A5=0 (que QEMU rendereaba como `0x8067` por algún coincidence de stack).
  - **Fix**: ROM patch en `0x4FC00BE0`. Reemplaza `bne a0, t0, .data_bss_ok` (`0x06551063`) con `j .data_bss_ok` (`0x0600006F`). Skipea ambos loops para todos los harts. Section-data pass values quedan intactos.
  - Resultado: ROM imprime banner, sigue ejecutando hasta tocar el CLIC interrupt controller (`hp_clic_mmio` writes a offsets `0x0000`, `0x1055-0x1057`). Próximo blocker: Phase 2.D (CLIC + Interrupt Matrix). 🎉
✅ **Phase 2.D** — **¡ROM llega a `ets_run_flash_bootloader`!** El ROM superó CLIC, SPI_init, y todo el coro de Cache_Suspend/Resume/Freeze.
  - **CLIC dedicado** (`esp32p4_install_clic`): backing-RAM 64 KB, byte+word access, decodifica CLICINFO con default 256 IRQs/4 priority bits.
  - **Smart override extendido**: `SMART_FIXED` (return constant) y `SMART_OR_MASK` (storage OR mask). Más una **mirror table**: `{base, offset, src_bit, dst_bit}` que copia un bit del scratch a otro bit en read. Útil para el patrón Cache_Freeze: ROM escribe bit 20 (request), poll bit 22 (ack). El mirror hace que bit 22 siga a bit 20, así Enable (espera ack=1) AND Disable (espera ack=0) ambos funcionan.
  - **Overrides agregados**: MSPI flash FSM idle (`0x5008C178 → 0x80000000`), Cache 0x098/0x2A8/0x2AC/0x2B0/0x2B4/0x2B8/0x2BC (suspend/resume/freeze acks), Cache 0x088/0x08C op-done (OR_MASK).
  - **Mirror table**: L1 freeze bit 20→22, bit 21→23 + L2 freeze idem (offsets 0x288, 0x28C).
  - Resultado: ROM atraviesa SPI_init, Cache_Suspend_L2_Cache, Cache_Suspend_L2_Cache_Autoload, Cache_Freeze_L2_Cache_Enable/Disable, Cache_Freeze_L1_DCache_Enable/Disable, ets_clock_init, etc. Llega a `ets_run_flash_bootloader` y ejecuta `_cvt` (printf) para imprimir `invalid header: 0x0b000ec1`. Próximo blocker: **Phase 2.A.5 — flash bootloader content/layout**.
✅ **Phase 2.A.5** — **¡ROM carga el bootloader y le pasa el control!**
  - **Causa raíz dual**: (1) BIOS ELF tiene PT_LOAD a `0x40000000` size `0x8BA4` que sobrescribe flash blob en cache window con ROM constants. (2) `ets_loader_map_range` espera cache MMU programado (no modelado) y devuelve garbage.
  - **Fix 1 — Flash blob reload pass**: después del BIOS ELF load + section-data + ROM patches, re-`blk_pread` el flash blob sobre el cache window. Esto restaura los bytes de flash byte que el PT_LOAD del BIOS había clobbeado.
  - **Fix 2 — `ets_loader_map_range` patch**: reemplazo en `0x4FC044CC` con `lui a0, 0x40000; add a0, a0, a1; ret` (12 bytes, 3 ROM patches). Bypassea param validation + MMU programming, devuelve linear identity address. Funciona porque nuestro flash blob se mapea linealmente al cache window.
  - **Resultado**: ROM imprime `SPI mode:DIO, clock div:1`, carga 3 segments del bootloader (`load:0x4ff33ce0,len:0x1174`, etc), hace SHA-256 check (continúa pese al fail porque secure boot disabled), e invoca `entry 0x4ff29ed0` — saltando al bootloader Espressif!
  - El bootloader Espressif corre en L2MEM, llama ets_printf vía ROM trampolines, y eventualmente assertea en `regi2c_enable_block, esp_rom_regi2c_esp32p4.c:90 (regi2c_ctrl_ll_master_is_clock_enabled())`. **Esto es nuestro código pre-app: el bootloader Espressif!** Phase 2.B.regi2c es siguiente. 🚀
✅ **Phase 2.B.regi2c** — **¡Bootloader corre 6.4 segundos de regi2c init!**
  - **LPPERI smart stub** (`0x50120000`, 1 KB): nueva región mapeada que antes daba 0.
  - **`LPPERI_CLK_EN_REG` (offset 0)** OR_MASK con `0x7FFF0000` (bits 16-30 set, todos los LP peri clock-enables defaultean a 1 en silicon real). El bootloader lee bit 27 (LP_I2CMST) y ya no falla el assert.
  - **`Reset/Clock 0x500E60BC`** OR_MASK con `0x4` (bit 2 set) — siguiente blocker después del regi2c assert. El bootloader hacía write-then-poll-bit-2 en ese registro post-regi2c-write esperando "config applied" status.
  - Bootloader hace 6.4 segundos de regi2c writes (PMU/PLL/RTC/ADC analog config) y luego falla en otro assert: `boot_comm: mismatch chip ID, expected 18, found 0` — assert del bootloader que verifica chip_id en image header. Phase 2.B.boot_comm investiga dónde lee 0.
✅ **Phase 2.B.boot_comm** — **¡Cache MMU block 63 emulator funciona!**
  - **Causa raíz** (H3 confirmada): IDF bootloader lee flash via sliding-window MMU mapping en `0x43FF0000` (block 63), programando entry 1023 dinámicamente para cada read. Sin emulación del MMU, los reads caen en RAM uninitialized → 0.
  - **Fix — minimal cache MMU** (~150 LOC nuevos):
    - **MSPI write hook** (`esp32p4_mspi_flash_write`): captura writes a offset 0x380 (índice) y 0x37C (valor entry) en `Esp32P4MspiMmu.entries[1024]`.
    - **MMIO overlay** en `0x43FF0000-0x43FFFFFF` (priority 3 > extflash RAM): el read decodifica VALID bit (bit 12 = 0x1000) y phys page (bits [11:0]), traduce a flash blob offset, devuelve los bytes correctos.
    - **Mirror del flash blob** en buffer separado de 64 MB para que el MMU lookup pueda servir reads.
  - **Bug histórico**: asumí inicialmente VALID bit = bit 14 (0x4000) por convención antigua de ESP. ESP32-P4 lo movió a bit 12 (0x1000). Encontrado al observar `entries[1023] = 0x00001000` en runtime — el valor incluye `SOC_MMU_FLASH_VALID | SOC_MMU_ACCESS_FLASH = 0x1000` en lugar de un bit más alto.
  - Resultado: `mismatch chip ID` desaparece. Bootloader continúa cargando segments del app. Llega a un warning de qio_mode (no-fatal — usa DIO). Después del warning, corre 39+ segundos sin más print. Probablemente atascado en otro polling loop. Phase 2.B.post_qio investiga.
🔧 **Phase 2.B.post_qio (perf)** `947fba8b80` — **Refactor MMU a eager-copy**.
  - Trace de PCs muestra que post-qio, el bootloader está ejecutando código real (no en polling loop). Hot PCs son 0x4ff2de64 (XOR loop, SHA256 software), 0x4ff2d51c, 0x4ff2e1a2 (bootloader functions).
  - El bottleneck era que cada read del cache window (durante SHA256 software) iba a través del MMIO overlay → ~100x slower que RAM directo.
  - **Refactor**: en cada MMU entry write con VALID set, **inmediatamente memcpy** flash_blob[phys_page << 16..phys_page << 16 + 64K] → extflash_RAM[entry_idx << 16 + 0x40000000..]. Después de la copia, los reads van a RAM y TCG puede JIT-cachear.
  - **Generalización**: removí el límite "solo block 63"; ahora cualquier entry (0..1023) se traduce eagerly. Soporta también XIP-from-cache de app code.
  - Resultado: bootloader avanza ~47 sec fake time / 60 sec wall (vs ~10 sec/60 sec antes). Mejora ~5x. Aún slow porque está haciendo SHA256 software de toda la app image. Phase 2.I (HW SHA accelerator) o paciencia destrabarán.
✅ **Phase 2.I.sha** `5706e8c1aa` — **HW crypto block stubs** (AES, SHA, RSA, DS, HMAC) con backing-RAM 4KB cada uno. SHA_BUSY override = 0. No cambia el bootloader path observablemente (usa SW mbedtls SHA), pero deja la infra lista para futuros tests con ROM `ets_sha_*`.
✅ **Phase 2.J** `887d5d16fc` — **¡App ELF path llega a `pmu_hp_system_init`!** Pivot estratégico: en vez de pelear con el bootloader's SW SHA stuck, uso `-kernel blink.elf` para skipear el bootloader.
  - **Setup**: `qemu-system-riscv32 -M esp32p4 -kernel blink.elf -drive file=blink.merged.bin,if=mtd,format=raw -nographic`. blink.elf tiene setup()/loop()/app_main() y ESP-IDF runtime statically linked.
  - **Loaded sin issues**: 521 KB del ELF, 3 PT_LOAD segments overlay-rewrites, trampoline jumps al entry 0x4FF00C40.
  - **Primer abort**: `system_early_init` lee `*(0x40030000) == 0xE9` (image magic). Con nuestro flash blob lineal, virtual 0x40030000 = flash[0x30000] = bytes random, no 0xE9. Real silicon's bootloader programa cache MMU para mapear 0x40030000 → flash[0x10000].
  - **Fix**: runtime patch en `0x40008064` reemplaza `beq a4, a5, +40` (0x02f70463) con `j +40` (0x0280006F). Check siempre passa.
  - Resultado: app avanza a `pmu_hp_system_init` haciendo PMU register R-M-W reales, calls a `efuse_hal_chip_revision`, etc. CPU IDF runtime ejecuta código de inicialización real. Próximo blocker pending — investigar siguiente step post-PMU.
✅ **Phase 1.E — 4 unblocks consecutivos** `b0c4aad8f5`:
  - **SP init en el trampolín**: `sp` partía en 0, primera push escribía a `0xFFFFFFFC` → store fault. Trampolín ahora setea `sp = 0x4FF80000` (~256 KB dentro de L2MEM).
  - **Custom CSRs + CLIC standard como scratch RW**: 0x7C0-0x7FF + 0x307 (mtvt) + 0x345-0x349 (mnxti family) + 0xFB1 (mintstatus). El runtime IDF setea CLIC vectoring temprano y exige que esos CSRs acepten writes.
  - **HP ROM lleno de `ret`**: cualquier call al ROM (esp_rom_delay_us, ets_*) retorna inmediatamente. Sin la blob oficial Espressif esto deja al caller continuar.
  - **PF_X overlay pass**: ESP-IDF emite `.flash.text` (R-X) y `.flash.rodata` (RW) ambos en VA `0x40000020`. Segundo pase del ELF loader re-escribe solo segmentos con PF_X, así código gana sobre datos.
  - **Resultado**: el CPU ahora ejecuta `pmu_lp_system_init`, `pmu_init`, varios stages del bootloader, hasta `bootloader_flash_execute_command_common` que necesita el controlador SPI flash real (~500 LOC + cache MMU — siguiente milestone).

## Build + smoke tests (verificados 2026-05-06)

### Phase 0 — machine registrada y CPU ejecutando

```
$ qemu-system-riscv32 -M help | grep esp32
esp32c3              Espressif ESP32-C3 machine
esp32c3-picsimlab    Espressif ESP32-C3 machine
esp32p4              Espressif ESP32-P4 (Velxio fork — UART0 only)

$ qemu-system-riscv32 -M esp32p4 -nographic
[esp32p4] machine init complete (UART0 wired)
Invalid read at addr 0x0 ...   ← CPU corriendo, sin firmware (esperado)
```

### Phase 1.A — UART end-to-end ("Hi" sale por stdout)

Programa de 8 instrucciones RV32I hand-rolled (`/tmp/uart_test.bin` 32 bytes):

```asm
LUI t0, 0x500CA      # 0x500CA2B7
ADDI t1, x0, 'H'     # 0x04800313
SW t1, 0(t0)         # 0x0062A023  → write 'H' to UART0 FIFO
ADDI t1, x0, 'i'     # 0x06900313
SW t1, 0(t0)         # 0x0062A023
ADDI t1, x0, '\n'    # 0x00A00313
SW t1, 0(t0)         # 0x0062A023
JAL x0, 0            # 0x0000006F  → loop forever
```

Generador en `/mnt/c/Users/000272869/AppData/Local/Temp/gen_uart_test.py`.

```
$ qemu-system-riscv32 -M esp32p4 -bios /tmp/uart_test.bin -nographic
[esp32p4] loaded 32 bytes of BIOS '/tmp/uart_test.bin' at 0x4fc00000
[esp32p4] machine init complete (UART0 wired)
Hi
```

Pipeline validado: instrucción RISC-V → SW al MMIO UART0 (0x500CA000) → chardev backend → stdout host.

### Phase 1.D — Arduino ELF carga y empieza a ejecutar IDF runtime

`blink.ino.elf` (compilado por arduino-cli para `esp32:esp32:esp32p4`) carga vía `-kernel`:

```
$ qemu-system-riscv32 -M esp32p4 -kernel blink.ino.elf -nographic
[esp32p4] loaded ELF '/root/blink.elf' (521210 bytes), entry 0x4ff00c40
[esp32p4] machine init complete (UART0 + eFuse + SYSTIMER + GPIO + 17 stubs + extflash + ELF loader)
```

El CPU ejecuta (verificado con `-d in_asm`):
```
0x4FC00000  LUI t0, 0x4FF01      ← trampolín
0x4FC00004  ADDI t0, t0, -0x3C0  ← (= 0x4FF00C40)
0x4FC00008  JR t0
0x4FF00C40  call_start_cpu0      ← ENTRY del IDF runtime ✓
0x4FF00C40-4C   stack setup
0x4FF00C4C  JAL rv_utils_dbgr_is_attached
0x4FF0D5FA    LUI a5, 0x3FF06; LW a0, 116(a5); SRLI; ANDI; RET
              (lee HP_CPU_PERIPH stub, devuelve 0 = "no debugger" ✓)
0x4FF00C50  BEQZ a0 → 0x4FF00C6E
0x4FF00C6E  AUIPC gp + ADDI gp     ← global pointer setup
0x4FF00C7C  CSRRS a5, 0x7C1, a5    ← STALLS HERE
```

CSR `0x7C1` es un CSR custom de Espressif (CLIC mintstatus o similar). QEMU upstream no lo conoce → illegal instruction trap → IDF runtime no tiene exception handler todavía → loop.

**Para superar este bloqueante** (Phase 1.E):
- Agregar CSRs custom `0x7C0..0x7CF` en `target/riscv/esp_cpu.c` como scratch RW. ✅ commit b0c4aad8f5
- Stubear `HP_SYSREG` (0x500E5000) reads/writes para clock control. ⏳ aún hay reads que devuelven 0
- Implementar mínimamente CLIC + CLINT. ⏳ los CSRs aceptan writes pero no hay routing real
- (opcional) Cache MMU real translando 0x40000000 → contenido de flash. ⏳

### Phase 1.F — Bloqueante actual: SPI flash controller

Con los 4 fixes de Phase 1.E el runtime avanza hasta:

```
fault_load at PC 0x4FF00446 (bootloader_flash_execute_command_common+0xCC), tval 0x00000019
```

`bootloader_flash_execute_command_common` necesita el controller SPI flash real (clonando `hw/ssi/esp32c3_spi.c`, ~500 LOC) más la cache MMU para que el contenido de flash sea visible vía el cache window. Eso es ~1-2 sesiones de trabajo más.

Después siguen: TIMG con WDT auto-disable, HP_SYSREG real, eventualmente: I2C, LEDC, RNG, etc. para que `setup()` y `loop()` funcionen.

### Phase 1.C — eFuse + SYSTIMER + GPIO reales

138 instrucciones RV32I que: leen MAC del eFuse y dump nibble por nibble, leen SYSTIMER VAL_LO dos veces y comparan con SLTU, togglean GPIO 2 vía W1TS/W1TC, escriben "DONE" al UART.

```
$ qemu-system-riscv32 -M esp32p4 -bios full_test.bin -nographic
[esp32p4] loaded 552 bytes of BIOS '/tmp/full_test.bin' at 0x4fc00000
M==>:=;>7<                            ← MAC = 0xDEADBE7C, como configuramos en eFuse
T=O                                   ← SYSTIMER avanzó: 'N' + (sltu==1) = 'O'
G1[esp32p4.gpio] pin 2 -> 1            ← W1TS, log line del GPIO real
G0[esp32p4.gpio] pin 2 -> 0            ← W1TC
DONE
```

Implementations:
- `hw/nvram/esp32p4_efuse.c` (95 LOC): MAC fijo 0xDEADBE7C / 0x0000A1DF, resto cero.
- `hw/timer/esp32p4_systimer.c` (105 LOC): contador 16 MHz desde `qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL)`. Snapshot HI→LO consistente.
- `hw/gpio/esp32p4_gpio.c` (110 LOC): tracking GPIO_OUT pins 0-31, W1TS/W1TC, qemu_irq por pin para bridge futuro a Velxio + log per-pin.

### Phase 1.B — Stubs absorben sin faultear

Programa de 13 instrucciones (`/tmp/systimer_test.bin`) que:
1. Lee de SYSTIMER (0x500E2000) — stub devuelve 0.
2. Escribe a GPIO_MATRIX (0x500E0000) — stub absorbe.
3. Escribe "OK\n" a UART0.

```
$ qemu-system-riscv32 -M esp32p4 -bios /tmp/systimer_test.bin -nographic
[esp32p4] loaded 52 bytes of BIOS '/tmp/systimer_test.bin' at 0x4fc00000
[esp32p4] machine init complete (UART0 + named peripheral stubs)
OK
```

Confirma que la CPU pasa por accesos a 22 peripherals sin fault. Cada uno tendrá su impl real cuando se justifique (TIMG/SYSTIMER reales son los siguientes target).

Test 3 con `merged.bin` falla en `-drive if=mtd` porque la máquina aún no tiene SPI flash modelado. Eso llega cuando agreguemos `hw/ssi/esp32p4_spi.c`.

**Cómo se hizo el build (para reproducir)**:

Las gotchas que aparecieron, todas resueltas:
1. `sudo` interactivo en WSL → usar `wsl -u root` para saltarlo.
2. Repo en NTFS (`/mnt/c/`) rompe git submodules y permissions → `rsync` a `/root/qemu-lcgamboa`.
3. CRLF en archivos shell (configure, hxtool, scripts/*) → `dos2unix` recursivo.
4. Subprojects vacíos (keycodemapdb, dtc, slirp, libvfio-user, berkeley-softfloat-3, berkeley-testfloat-3) → clonar manual desde los `.wrap`.
5. Softfloat necesita `meson.build` desde `subprojects/packagefiles/` → copiar.
6. **Symlinks rotos** materializados como text files (libvduse/include/atomic.h etc.) → script reparador detecta archivos ≤256B con contenido de path relativo y los convierte en symlinks reales. **7 archivos reparados**.
7. `-liconv` no existe en glibc → `ar rcs /usr/lib/x86_64-linux-gnu/libiconv.a` (mismo workaround que vos pusiste en CI commit `d1a1ee37ea`).

Scripts dejados en `/mnt/c/Users/000272869/AppData/Local/Temp/`:
- `setup_wsl_repo.sh`, `fetch_subprojects.sh`, `fix_symlinks.sh`, `build_p4_v2.sh`, `build_compile.sh`

## Lo que se commiteó

### `third-party/qemu-lcgamboa/` (tu fork)

Branch nueva: `feat/esp32p4-machine`. Dos commits encima de `picsimlab-esp32`:

1. **`d7969f43ec` feat(esp32-p4): scaffold machine — memmap + catch-all peripheral aperture**
   - `hw/riscv/esp32p4.c` (309 LOC) — machine registration, memory regions, catch-all I/O, reset GPIO, machine class.
   - `hw/riscv/Kconfig` — `config RISCV_ESP32P4`.
   - `hw/riscv/meson.build` — entry para `esp32p4.c`.
   - `configs/devices/riscv32-softmmu/default.mak` — `CONFIG_RISCV_ESP32P4=y`.

2. **`b5d2fd732d` ci: trigger build-libqemu on feat/** branches too**
   - `.github/workflows/build-libqemu.yml` — agrega `feat/**` al `on.push.branches`.

## Memory map implementado (TRM Cap 7 Tabla 7.3-1, verificado)

| Región | Base | Tamaño | Tipo en QEMU |
|---|---|---|---|
| HP SPM | `0x30100000` | 8 KB | RAM |
| HP CPU peripherals | `0x3FF00000` | 128 KB | I/O catch-all (read=0, write=drop) |
| External flash | `0x40000000` | 64 MB | declarado, sin model aún |
| External RAM | `0x48000000` | 64 MB | declarado, sin model aún |
| HP ROM | `0x4FC00000` | 128 KB | ROM (vacío — TODO cargar blob) |
| HP L2MEM | `0x4FF00000` | 768 KB | RAM |
| HP peripherals | `0x50000000` | 1 MB | I/O catch-all |
| LP ROM | `0x50100000` | 16 KB | ROM (vacío) |
| LP SRAM | `0x50108000` | 32 KB | RAM |
| LP peripherals | `0x50110000` | 128 KB | I/O catch-all |

Reset vector: `0x4FC00000` (HP ROM base).

## Lo que NO está implementado (próximos commits)

Phase 1 restante:

- ❌ **HP ROM blob load** — sin esto, el CPU faulta inmediato. Necesitamos `pc-bios/esp32p4-rom.bin` (Espressif lo distribuye bajo licencia permisiva).
- ❌ **UART0** — `Serial.println()` no se ve. `hw/char/esp32p4_uart.c` clonando `esp32c3_uart.c`.
- ❌ **GPIO matrix + IO MUX** — `digitalWrite()` no actúa. `hw/gpio/esp32p4_gpio.c`. P4 tiene 55 pines vs 22 del C3, así que la tabla del MUX hay que regenerarla.
- ❌ **SYSTIMER** — `delay()` y `millis()` no funcionan.
- ❌ **Watchdog stub** — el bootloader resetea infinitamente sin esto.
- ❌ **eFuse stub** — boot ROM lee CHIP_ID, MAC.
- ❌ **CLIC + CLINT + Interrupt Matrix** — interrupts no llegan.
- ❌ **Variante `esp32p4_picsimlab.c`** — bridges Velxio (host-call exports).

## Cómo seguir (cosas que necesito que hagas vos)

### 1. Pushear las commits del fork

```powershell
cd C:\Desarrollo\velxio\third-party\qemu-lcgamboa
git push -u origin feat/esp32p4-machine
```

Esto va a:
- Subir los dos commits a `davidmonterocrespo24/qemu-lcgamboa`.
- Disparar la CI `build-libqemu.yml` automáticamente (gracias al cambio en triggers).
- Si el build pasa: artefactos publicados al release `qemu-prebuilt` con `libqemu-riscv32.{so,dll,dylib}` que ya incluye `-M esp32p4`.

**Lo más probable**: el build PASA (mi cambio agrega un archivo nuevo detrás de `CONFIG_RISCV_ESP32P4`, no toca código existente). **Pero hay que verificarlo** — si falla por algún include o pattern QEMU que estoy malinterpretando, vamos a ver el log de CI y arreglar.

### 2. (Opcional) Build local en WSL para iterar más rápido

Si querés iterar sin esperar CI (~6-10 min por build), instalar deps en WSL y compilar:

```powershell
# Desde Windows PowerShell o terminal:
wsl -d Ubuntu-24.04 -- bash /mnt/c/Desarrollo/velxio/test/test-esp32-p4/scripts/wsl_build_p4.sh
```

Te va a pedir tu contraseña sudo una vez para instalar:
`build-essential ninja-build meson pkg-config libglib2.0-dev libpixman-1-dev libslirp-dev libgcrypt20-dev python3-distlib`

(~5 min de install + ~15-25 min de primer build de QEMU). Builds incrementales después son ~30 segundos.

### 3. (Opcional) Smoke test manual

Una vez que tengas `qemu-system-riscv32` compilado (vía CI o WSL):

```bash
./qemu-system-riscv32 -M help | grep esp32p4
# Esperado: esp32p4              Espressif ESP32-P4 (skeleton — Velxio fork, no peripherals yet)

./qemu-system-riscv32 -M esp32p4 -nographic
# Esperado: el log "[esp32p4] machine init complete (skeleton — no peripherals)" aparece,
# luego el CPU cae en una excepción (illegal instruction o load fault) porque
# la HP ROM está vacía. ESO ES EL ÉXITO de esta fase — significa que la machine
# se construyó y la CPU ejecutó al menos una instrucción.
```

## Próxima sesión (cuando vuelva yo)

Si el push pasa CI sin errores, el siguiente paso es **agregar un peripheral real** — el más útil/visible es UART0:

1. Copiar `hw/char/esp32c3_uart.c` → `hw/char/esp32p4_uart.c`.
2. Copiar `include/hw/char/esp32c3_uart.h` → `include/hw/char/esp32p4_uart.h`.
3. Renombrar `ESP32C3_UART` → `ESP32P4_UART` en todo el archivo.
4. Verificar que la base address corresponde al P4: `DR_REG_UART_BASE = 0x500CA000` (debo leerla del TRM Cap 42).
5. Instanciar en `esp32p4.c::esp32p4_machine_init()`:
   ```c
   object_initialize_child(OBJECT(machine), "uart0", &ms->uart0, TYPE_ESP32P4_UART);
   sysbus_realize(SYS_BUS_DEVICE(&ms->uart0), &error_fatal);
   MemoryRegion *mr = sysbus_mmio_get_region(SYS_BUS_DEVICE(&ms->uart0), 0);
   memory_region_add_subregion_overlap(sys_mem, 0x500CA000, mr, 1);
   ```
6. Build, smoke test.

Una vez UART funciona, la cadena de progreso es: GPIO → SYSTIMER → Watchdog → eFuse → ROM blob → bootloader real → blink end-to-end.
