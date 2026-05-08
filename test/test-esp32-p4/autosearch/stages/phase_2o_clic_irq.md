# Phase 2.O — SYSTIMER 100 Hz tick → CPU IRQ wiring

**Estado**: ✅ done · commit `94f989a274`

## Goal

Sin un tick periódico delivered al CPU, el FreeRTOS scheduler no puede preempt tasks. Phase 2.O conecta el SYSTIMER device con la línea M-mode external interrupt (`IRQ_M_EXT`) del CPU RISC-V.

## Implementación

### 1. SYSTIMER state extendido (`include/hw/timer/esp32p4_systimer.h`)

```c
typedef struct ESP32P4SysTimerState {
    SysBusDevice parent_obj;
    MemoryRegion iomem;
    uint64_t snapshot;

    /* Phase 2.O: tick timer + IRQ output line. */
    QEMUTimer *tick_timer;
    qemu_irq  irq_target0;
    uint64_t  tick_period_ns;
} ESP32P4SysTimerState;
```

### 2. Tick callback (`hw/timer/esp32p4_systimer.c`)

```c
static void esp32p4_systimer_tick(void *opaque)
{
    ESP32P4SysTimerState *s = opaque;
    qemu_set_irq(s->irq_target0, 1);     // assert
    qemu_set_irq(s->irq_target0, 0);     // de-assert (edge)
    timer_mod(s->tick_timer,
              qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL) + s->tick_period_ns);
}
```

En `realize()`:
- `sysbus_init_irq(...)` registra una IRQ output del sysbus device.
- `timer_new_ns(QEMU_CLOCK_VIRTUAL, ...)` crea el timer.
- `tick_period_ns = 10_000_000` = 10 ms = 100 Hz (default `CONFIG_FREERTOS_HZ`).

### 3. Wiring en machine_init (`hw/riscv/esp32p4.c`)

```c
sysbus_connect_irq(SYS_BUS_DEVICE(&ms->systimer), 0,
                   qdev_get_gpio_in(DEVICE(&ms->soc), IRQ_M_EXT));
```

`qdev_get_gpio_in(cpu, IRQ_M_EXT)` devuelve la entrada GPIO de la CPU para M-mode external interrupt. `sysbus_connect_irq(..., 0, ...)` conecta el output IRQ #0 del systimer al input.

Cuando el tick callback hace `qemu_set_irq(level=1)`, el handler `riscv_cpu_set_irq` ejecuta:
1. `riscv_cpu_update_mip(env, 1 << IRQ_M_EXT, BOOL_TO_MASK(level))` — setea bit `MIE_MEIE` en mip.
2. Si mip != 0: `cpu_interrupt(cs, CPU_INTERRUPT_HARD)` — flag al main loop.
3. CPU traps a mtvec en el siguiente fetch.

## Validación

Build limpio. Hello world (Phase 2.N) sigue funcionando — el tick fires en background pero los bypass patches (que tienen busy loop al final) absorben los traps con su mtvec handler default.

```
$ qemu-system-riscv32 -M esp32p4 -kernel blink.elf ...
[esp32p4] runtime patches applied (55 entries)
[esp32p4] machine init complete (...)
Hello from QEMU ESP32-P4!
```

## Próximo paso (Phase 2.P)

Drop los Phase 2.K-2.N bypass patches y dejar que el flow original Arduino corra:
- `start_cpu0_default → main_task → app_main → initArduino → setup() → loop()`
- Con el SYSTIMER tick driving FreeRTOS scheduler, `vTaskDelay(1000)` etc. funcionarán.
- Veremos `Serial.println(...)` y eventualmente `digitalWrite(LED)` cycling.

## Notas

- El handler `riscv_cpu_update_mip` en `target/riscv/cpu_helper.c` es el punto de entrada estándar. Su lógica integra correctamente con CSR mip/mie y con la trap dispatch del CPU.
- ESP32-P4 tiene CLIC en lugar del PLIC standard. QEMU's RISC-V CPU NO tiene CLIC support nativo, así que la trap goes via `mtvec` (CLINT mode), no `mtvt` (CLIC mode). Es una simplificación pero funcional para nuestro caso ya que la app está bypass-eada.
- Si en el futuro queremos correr IDF nativo con CLIC, hay que extender el target/riscv para soportar `xnxti` CSR family, hardware vectoring, etc. Trabajo significativo (~500 LOC en target/).

## Archivos tocados

- `include/hw/timer/esp32p4_systimer.h` — state struct extendido
- `hw/timer/esp32p4_systimer.c` — tick callback + realize timer init
- `hw/riscv/esp32p4.c` — sysbus_connect_irq wiring
