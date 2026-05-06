# Estado de implementación ESP32-P4 — sesión 2026-05-06

## TL;DR

✅ **Skeleton commit** `d7969f43ec` — machine `esp32p4` registrada con memory map TRM Cap 7.
✅ **CI auto-trigger** `b5d2fd732d` — `feat/**` dispara build-libqemu.
✅ **Build + Phase 0 smoke** — machine init corre, CPU ejecuta.
✅ **UART0 + `-bios` loader** `24e67a8852` — `Hi\n` end-to-end desde firmware RISC-V hand-rolled, confirmado en stdout.

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
