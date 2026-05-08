# Phase 2.S — Real CLIC mode dispatch in target/riscv

**Estado**: ✅ done — IDF interrupt handler now executes on each
SYSTIMER tick, end-to-end CLIC pipeline working.

## Goal

Implementar suficiente CLIC (Core-Local Interrupt Controller, RISC-V
v0.9 spec con extensiones de Espressif) en `target/riscv/esp_cpu.c`
para que el IDF runtime pueda usar su tabla de vectores nativa
(`_mtvt_table` en `vectors_clic.S`) en lugar de saltar a un único
trap entry como con mtvec mode 0/1.

## Documentos consultados

1. `third-party/esp-idf/components/riscv/include/esp_private/interrupt_clic.h`
   - `MTVEC_MODE_CSR = 3` (mtvec[1:0]=11 = CLIC mode).
   - `MTVT_CSR = 0x307` (vector table base).
   - `MINTSTATUS_CSR = 0x346` (no estándar para ESP32-P4).
   - `RV_EXTERNAL_INT_OFFSET = 16` — primeras 16 causas son sistema.
2. `third-party/esp-idf/components/riscv/vectors_clic.S` — la tabla
   real `_mtvt_table` con 48 entradas. Causas 0..15 → `_panic_handler`,
   16..39 → `_interrupt_handler`, 40..43 → handlers de panic
   especiales.
3. `third-party/qemu-lcgamboa/target/riscv/csr.c::write_mtvec` — el
   write upstream **silenciosamente rechaza** mode > 1.
4. `target/riscv/esp_cpu.c` previo a Phase 2.S — los CSRs CLIC
   (mtvt, mnxti, mintstatus, …) ya estaban como scratch RW (Phase
   1.F-lite), pero sin semántica de dispatch.

## Lo que SE INVESTIGÓ

### Discovery 1 — `write_mtvec` upstream rechaza mode > 1

Test con build incremental + `fprintf` en
`esp_cpu_csr_write` para 0x305:

```
[esp_cpu.write_mtvec] value=4fc1ffb0 mode=0  ← trampoline (Phase 2.R)
(IDF tries csrw mtvec, 0x4FF00003 — silently dropped)
mtvec stays at 0x4FC1FFB0
```

QEMU upstream code en `target/riscv/csr.c:1817`:

```c
if ((val & 3) < 2) {
    env->mtvec = val;
} else {
    qemu_log_mask(LOG_UNIMP, "CSR_MTVEC: reserved mode not supported\n");
}
```

**Fix**: override `write_mtvec` con nuestra versión que acepta mode 3.
Sigue el mismo patrón usado para `mstatus` en
`esp_cpu_class_init`.

### Discovery 2 — Dispatch correcto en CLIC mode

Spec CLIC: cuando `mtvec[1:0] == 11` y se toma una interrupción
asíncrona, el CPU lee `*(mtvt + cause * 4)` para obtener el address
del handler (32-bit function pointer en RV32). NO usa
`mtvec + cause * 4` como en mode 1.

`mtvec[31:6] << 6` se usa solo para excepciones síncronas (illegal
instr, page fault…) en CLIC mode.

**Implementación** en `esp_cpu_exec_interrupt`:

```c
const uint32_t mtvec_mode = env->mtvec & 0x3;
if (mtvec_mode == 3) {
    const target_ulong mtvt = riscv_csr_read(env, 0x307);
    uint32_t handler = 0;
    cpu_physical_memory_read(mtvt + (cause * 4), &handler, 4);
    handler = le32_to_cpu(handler);
    env->pc = handler & ~1u;
}
```

### Discovery 3 — SYSTIMER en cause 1 → panic determinista

Después de habilitar mode 3, el primer tick disparó `Guru Meditation
Error` con `MCAUSE = 0xfffffff1`. El IDF panic handler corrió completo
(register dump + stack trace por UART real, no inline writer).

Análisis: `vectors_clic.S` mapea causas 0..15 a `_panic_handler`
(comentario: "System interrupt number"). SYSTIMER estaba cableado a
`espressif-cpu-irq-lines[1]`, así que `cpu->irq_cause = 1`, mcause =
`0x80000001`, mtvt[1] = `_system_int_handler` = `_panic_handler`.

**Fix**: cambiar el wiring de SYSTIMER a línea 17 (= cause 17, en el
rango "free" 16..39). Ahora dispatch va a `_interrupt_handler` (común)
que itera la lista de handlers C registrados — ninguno match,
return graceful, sin panic.

## Output observado (validación final, build con `ESP_CPU_IRQ_DEBUG=1`)

```
[esp_cpu.write_mtvec] value=4fc1ffb0 mode=0   ← Phase 2.R trampoline
[esp_cpu.write_mtvec] value=4ff00003 mode=3   ← IDF runtime, mode 3 ACCEPTED
[esp_cpu.csr_write] csr=0x307 value=4ff00040  ← IDF sets mtvt = _mtvt_table
[esp_cpu.irq_handler] #1   line=17 accept=0   ← boot, MIE=0
Hello from QEMU ESP32-P4!
[esp_cpu.exec_interrupt] #1 accepted=1 irq_cause=17 mtvec=4ff00003
[esp_cpu.exec_interrupt] #2 accepted=1 irq_cause=17 mtvec=4ff00003
[esp_cpu.exec_interrupt] #3 accepted=1 irq_cause=17 mtvec=4ff00003
[esp_cpu.exec_interrupt] #4 accepted=1 irq_cause=17 mtvec=4ff00003
[esp_cpu.irq_handler] #129  line=17 accept=1 mstatus=0x1888 (MIE=1)
[esp_cpu.irq_handler] #257+ line=17 accept=1 mstatus=0x1888 (MIE=1)
... (continuous, ~100 Hz)
```

`mstatus=0x1888` estable confirma que MIE permanece habilitado. El
IDF `_interrupt_handler` está procesando cada tick correctamente y
retornando vía `mret`.

Build default (sin debug) muestra solo `Hello from QEMU ESP32-P4!`
seguido del busy loop — **sin panic, sin output ruidoso**.

## Lo que NO funcionó (intentado y descartado)

1. **Trampoline pre-instala MTVT table en HP ROM (0x4FC1FF00)**:
   armé un mtvt sintético + extendí trampoline a 11 instrucciones con
   `csrw mtvt, 0x4FC1FF00`. El IDF runtime lo sobrescribe ~10ns
   después con su `_mtvt_table` real, así que el trabajo extra fue
   inútil. **Revertido**: trampoline vuelve a 8 instrucciones (Phase
   2.R) y el mtvt setup se delega 100 % al IDF.

2. **Encoding inicial de `csrw mtvec, t1`**: probé `(0x305 << 20) |
   (1 << 12) | (6 << 15) | 0x73 = 0x30531073` — correcto pero como
   QEMU rechazaba mode 3, el efecto era nulo. Solo después de
   diagnosticar via `esp_cpu_csr_write` debug pude confirmar que el
   write SÍ se ejecutaba pero no se persistía.

3. **Asumí que `esp_cpu_csr_write` recibiría mtvec writes**: NO —
   mtvec está registrado en `csr.c::csr_ops_init` con `write_mtvec`
   estándar. Para interceptarlo, hay que registrar override via
   `riscv_set_csr_ops(CSR_MTVEC, &ops)` en class init (mismo idiom
   que mstatus override).

## Lo que SÍ funcionó

| Fix                                              | Verificado por                |
|--------------------------------------------------|-------------------------------|
| Override `write_mtvec` para aceptar mode 3       | `[esp_cpu.write_mtvec] mode=3`|
| Read mtvt + dispatch en CLIC mode                | irq_cause=17 mtvec=4ff00003   |
| `cpu_physical_memory_read` para mtvt indirection | (no panic en handler IDF)     |
| Reroute SYSTIMER a cause 17 (no system)          | Ningún `Guru Meditation`      |
| Hello world default build                         | "Hello from QEMU ESP32-P4!"   |
| Stability over time                              | mstatus=0x1888 ticks #129..897|

## Implementación final

### `target/riscv/esp_cpu.c`

1. Nuevo override `esp_cpu_write_mtvec`:
   ```c
   static RISCVException esp_cpu_write_mtvec(CPURISCVState *env,
                                             int csrno, target_ulong val) {
       env->mtvec = val;  /* accept all modes incl. 3 (CLIC) */
       return RISCV_EXCP_NONE;
   }
   ```
2. Registrar en `class_init`:
   ```c
   riscv_csr_operations mtvec_ops;
   riscv_get_csr_ops(CSR_MTVEC, &mtvec_ops);
   mtvec_ops.write = esp_cpu_write_mtvec;
   riscv_set_csr_ops(CSR_MTVEC, &mtvec_ops);
   ```
3. Branch en `esp_cpu_exec_interrupt` para `mtvec_mode == 3` que
   lee `mtvt + cause*4` via `cpu_physical_memory_read` y setea
   `env->pc` al function pointer.
4. Debug instrumentation gated bajo `ESP_CPU_IRQ_DEBUG` para
   `csrw mtvec` y `csrw mtvt` (CSR 0x305 + 0x307).
5. Include `exec/cpu-common.h` para `cpu_physical_memory_read`.

### `hw/riscv/esp32p4.c`

1. SYSTIMER target0 → `espressif-cpu-irq-lines[17]` (era 1).
   - Comentario actualizado para explicar la elección.
2. Trampoline NO se modifica — Phase 2.R behavior preservado para
   el caso "no IDF runtime mtvec setup".

## Lessons learned

1. **QEMU upstream silently rejects unknown CSR mode bits.** Cuando
   override de un CSR estándar para extender semántica, hay que
   verificar que el upstream no tenga validation que descarte el
   caso nuevo.
2. **CLIC mode dispatch uses indirection** (`pc = *(mtvt + cause*4)`),
   NO una fórmula computacional. La diferencia es importante: las
   entradas de la tabla son punteros a funciones, no instrucciones
   directas.
3. **IDF reserva causes 0..15 como "system interrupts"** que siempre
   redirigen a panic. Cualquier IRQ deliveries en QEMU debe usar
   causes 16+ a menos que se quiera específicamente el handler de
   panic.
4. **El IDF panic handler ES output útil**: si vemos un Guru
   Meditation Error, eso significa que llegó a IDF code real, no
   solo nuestro bypass. La pila completa (printf+UART+stack) corre.
5. **`riscv_csr_read(env, csrno)` desde dentro de un dispatcher
   funciona** y respeta los overrides registrados. No bypass del
   esp_cpu CSR ops.

## Próximas fases

- **Phase 2.T**: completar emulación de Cache MMU. Sin esto, el
  bypass-flow se pega en el `esp_log_cache_get_level` lock loop
  cuando se tenga acceso a tabla de partición real.
- **Phase 2.U**: dropear los Phase 2.M-2.O bypass patches y dejar el
  flow natural Arduino correr (depende de 2.T + un mecanismo para
  que la app instale handlers SYSTIMER que pongan `tickHook` real).
- **Phase 2.V**: implementar `mnxti` y `mintstatus` con semántica real
  (hoy son scratch RW). Necesario para preempción multi-nivel real.

## Estado consolidado (post-2.S)

| Hito                                                    | Estado       |
|---------------------------------------------------------|--------------|
| ROM banner                                              | ✅           |
| Bootloader runs 6.4s                                    | ✅           |
| App ELF runs (174 fns)                                  | ✅           |
| FreeRTOS scheduler entered                              | ✅           |
| `app_main` reached                                      | ✅           |
| Primer UART output (hello world)                        | ✅           |
| SYSTIMER tick wired                                     | ✅           |
| IRQ delivery a esp_cpu dispatcher                       | ✅ Phase 2.Q |
| Trap to `mtvec` firing (sin crash)                      | ✅ Phase 2.R |
| End-to-end IRQ con MIE persistente                      | ✅ Phase 2.R |
| **mtvec mode 3 acceptable + CLIC mtvt dispatch**        | ✅ Phase 2.S |
| **IDF `_interrupt_handler` runs on every tick**         | ✅ Phase 2.S |
| Cache MMU emulation                                     | ❌ Phase 2.T |
| Real `setup()` runs                                     | ❌ Phase 2.U |
| `digitalWrite(LED)` blink visible                       | ❌ Phase 2.U |
| `mnxti`/`mintstatus` real semantics (multi-level pre-empt) | ❌ Phase 2.V |
