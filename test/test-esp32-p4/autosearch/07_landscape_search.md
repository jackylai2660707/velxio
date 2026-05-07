# 07 — Búsqueda exhaustiva de prior work — sesión 2026-05-07

Pregunta del usuario: *"¿no había ningún repo que nos acercara? Pensé que toda la CPU estaba implementada."*

Respuesta corta: **No, no hay nada más cerca. La CPU sí está implementada, pero los periféricos no.**

## Lo que sí está implementado (gratis para nosotros)

QEMU upstream tiene emulación RISC-V madura:
- Decoder RV32I + extensiones I/M/A/F/C/Zb/Zc completas (verificado: tras enabling RVA+RVF, las instrucciones `lr.w/sc.w` corren).
- Exceptions, MMU, atomics, FPU IEEE-754 single.
- ~30 años de bug fixes y optimizaciones del proyecto QEMU.
- Funciona idéntico al silicio real para cualquier instrucción RISC-V estándar.

**Esto es ~80% del trabajo de "emular un CPU"** y lo tenemos gratis.

## Lo que NO está implementado en ningún sitio público

Los **periféricos específicos del ESP32-P4**: GPIO matrix, UART (sus registros específicos), I2C, SPI, cache MMU, interrupt matrix, SYSTIMER, TIMG/WDT, MIPI, USB OTG, etc.

Búsqueda exhaustiva (sesión 2026-05-07):

### Repos de QEMU forks revisados

| Repo | ESP32-P4? | Notas |
|---|---|---|
| `espressif/qemu` (oficial) | ❌ | Issue #127 abierto desde mayo 2025, status "To Do". Último año: 30+ commits, ZERO mencionan P4/C6/H2. Solo iteran sobre ESP32/S3/C3 existentes |
| `lcgamboa/qemu` (PICSimLab) | ❌ | Solo agrega WiFi/ESPNOW al ESP32 + C3 |
| `Ebiroll/qemu_esp32` | ❌ | Solo Xtensa ESP32 |
| `epiclabs-uc/qemu-esp32` | ❌ | Espejo de Espressif |
| `mluis/qemu-esp32` | ❌ | Variante ESP32 |
| `esp32-open-mac/qemu` | ❌ | Reverse-engineering del WiFi del ESP32 original |
| **50 forks** de espressif/qemu listados en GitHub | ❌ | Revisé branches de los 8 más recientes: NINGUNO tiene branches con `p4`, `c6`, `h2`, o feat/* relacionado a chips nuevos. Todos son clones del upstream |

### Otros emuladores

| Proyecto | ESP32-P4? | Notas |
|---|---|---|
| **Wokwi** (closed source) | ✅ "Beta" | Tienen el simulador funcionando. Engine 100% privado. Sus repos open source son `avr8js`, `rp2040js`, `esp8266js` — **NO** hay esp32js o esp32p4js |
| **Cirkit Designer** (closed source) | ❌ S3, no P4 | Anunciado **2026-05-05** (hace 2 días!): ESP32-S3 simulator en Rust/WASM. Equipo pequeño, 8 meses de trabajo. Cerrado |
| **Renode** (open source) | ❌ | Soporte ESP32 mejorado en 1.14 (community contribution). NO mencionan P4 |
| **TinyEMU / rvemu / riscv-rust** | ❌ | Emulan CPU RISC-V genérico, no ESP32 |

### ESP-IDF Linux target — opción interesante pero distinta

Espressif tiene un *"linux target"* experimental: `idf.py --preview set-target linux`. **No es QEMU** — compila la app IDF como ejecutable Linux nativo, con FreeRTOS POSIX simulator. Limitaciones documentadas:
- "Experimental feature".
- "Functions that are not async-signal-safe should be avoided".
- Component table muestra que la mayoría de los componentes NO tienen mock o sim.

No sirve para Velxio porque:
1. Velxio carga `merged.bin` flasheado, no compila para target=linux.
2. Bytecode-level emulation de Arduino sketches necesita el target específico ESP32-P4.

Pero confirma que **ni siquiera Espressif considera QEMU su path principal** — usan POSIX simulation. El QEMU está oficialmente "work in progress and has not been documented yet".

## Por qué la CPU está pero los periféricos no

QEMU es framework de emulación. Soporta dos cosas separadas:
- **Target architectures** (CPUs): `target/riscv/`, `target/xtensa/`, `target/arm/`. Son interpretadores de la ISA.
- **Machine models** (chips): `hw/riscv/sifive_e.c`, `hw/riscv/spike.c`, `hw/riscv/microchip_pfsoc.c`. Especifican qué CPU y qué periféricos forman un chip concreto.

Para QEMU, "RISC-V" como CPU está done desde hace años. Pero cada machine concreta (cada chip) es trabajo separado:

```
hw/riscv/microchip_pfsoc.c     29 KB    Microchip PolarFire SoC
hw/riscv/sifive_u.c            41 KB    SiFive Unleashed
hw/riscv/spike.c               14 KB    UC Berkeley Spike (testbench)
hw/riscv/virt.c                ~50 KB   QEMU virt board
hw/riscv/esp32c3.c             28 KB    Espressif ESP32-C3
hw/riscv/esp32p4.c             ???      <- nosotros estamos escribiendo esto
```

Más los archivos por-peripheral (`hw/char/<chip>_uart.c`, `hw/gpio/<chip>_gpio.c`, etc.). Cada chip son 1500-3000 líneas de C nuevas.

## Por qué Espressif no lo hizo todavía

Hipótesis razonables (mirando su public commit log + roadmap):
1. **Priorizan el silicio real** — testing en QEMU es nice-to-have.
2. **ESP-IDF Linux target les soluciona el caso de uso de unit testing**.
3. **El P4 es muy nuevo** (lanzado 2024). Su QEMU support para chips anteriores tomó 6-12 meses cada uno.
4. **MIPI-CSI/DSI** del P4 son complejas — probablemente esperan que la silicio se estabilice antes de invertir en emulación.

## Conclusión honesta

**Sí, somos pioneros**. No es que falte un atajo evidente — es que el camino simplemente no existe todavía públicamente.

- Wokwi y Cirkit Designer lo han hecho **closed source**.
- Espressif lo hará eventualmente, pero el último año NO ha tocado P4/C6/H2.
- Cualquier equipo open-source que quiera ESP32-P4 emulado tiene que escribirlo. Nosotros estamos en eso.

**Por lo que sumamos**: la primera tentativa pública open-source de soportar ESP32-P4 en QEMU está en `feat/esp32p4-machine` de tu fork. 12 commits, ~700 LOC propias, llega hasta el IDF runtime ejecutando código real (rtc_clk_init, regi2c, cache_hal). Eso es lo más cerca que cualquier fork público ha llegado.

## Implicaciones para el plan

Considerando este landscape, hay **3 caminos pragmáticos** además del iterative-patch loop:

### Camino A: Continuar phase iterative (estado actual)
Seguir Phase 1.L con patches/overrides. Ritmo: ~500-1000 líneas de IDF execution por iteración. Timeline: semanas para llegar a `app_main`.

### Camino B: Atajo "no IDF" para Arduino sketches
Modificar el toolchain Velxio para que los sketches Arduino para ESP32-P4 se linkeen sin el ESP-IDF runtime, usando un mini-runtime que solo provee:
- Stack init.
- `Serial.println` que escribe directo al UART0 register (`0x500CA000`) — ya funciona.
- `digitalWrite` que escribe al GPIO matrix — ya funciona.
- `delay()` que busy-waits en SYSTIMER — ya funciona.
- `setup()` y `loop()` llamados directamente.

Resultado: blink funciona en QEMU **HOY** sin más trabajo en QEMU, pero limita features a un subset Arduino básico (no WiFi, no librerías que dependan del IDF).

### Camino C: Esperar a que Wokwi/Espressif libere
Dejar el work de QEMU pausado hasta que upstream Espressif (o algún fork) implemente lo gordo.
Riesgo: meses/años de espera.

### Camino D (mi recomendación): hybrid
- **Corto plazo**: hacer el camino B (mini-runtime Arduino sin IDF) para tener un demo funcional en Velxio en días, no meses.
- **Largo plazo**: seguir el iterative patching como hobby project. Cuando llegue a `app_main` podremos correr cualquier sketch IDF-completo.

¿Querés que diseñemos el camino B? Es factible — Arduino-cli ya soporta un toolchain custom y el linker de RISC-V es flexible. Probablemente 1-2 sesiones de trabajo para tener blink visible.
