# Phase 2.T-fix.next.next — Print::write neutralization, hits FreeRTOS state corruption

**Estado**: ✅ done — Print::write neutralized; new blocker is FreeRTOS
state corruption (`uxListRemove` called with garbage pointer).

## Lo que SE INVESTIGÓ

### 1. Trace del fault en 0x4000079A (NULL+12)

Drop bypass + run con `-d in_asm`. El log mostró:

```
IN: _ZN5Print5writeEPKc      ← Print::write(const char*) (mangled C++)
0x40000798: 40f2     lw ra, 28(sp)
0x4000079a: 47dc     lw a5, 12(a5)   ← FAULTS: a5 = 0, reading 0x0+12
0x4000079c: 6105     addi sp, sp, 32
0x4000079e: 8782     jr a5
```

### 2. Diagnóstico

This is a **classic C++ virtual-function tail-call dispatch**. The
compiled code for `Print::write(const char*)`:

```cpp
size_t Print::write(const char *str) {
    if (str == NULL) return 0;
    return write((const uint8_t *)str, strlen(str));  // virtual call
}
```

The virtual call expands to:
```
a5 = *(this + 0)        ; load vtable_ptr
a5 = *(a5 + 12)         ; load method address from vtable[3]
jr a5                   ; tail-call method
```

`a5 = 0` going into the second load means **the vtable_ptr was NULL**
— the global `Serial` object's first field (vtable pointer) is 0.

Root cause: our scheduler/init bypass patches (Phase 2.K, 2.M)
**skipped the C++ static-constructor pass**. The global `Serial`
object lives in `.bss`, zero-initialised, never had its vtable
populated by the C++ runtime.

### 3. Fix mínimo

Replace the failing dispatch with a no-op that preserves stack
discipline:

```
0x40000798: 40f2     lw ra, 28(sp)        (keep)
0x4000079a: 4501     c.li a0, 0           (replace lw a5, 12(a5))
0x4000079c: 6105     addi sp, sp, 32      (keep)
0x4000079e: 8082     c.ret                (replace jr a5)
```

Encodings:
- `c.li a0, 0` = `0x4501` (funct3=010, imm=0, rd=10, op=01)
- `c.ret` (= `c.jr ra`) = `0x8082`

Function now returns 0 bytes-written without faulting. Side effect:
`Serial.println("...")` becomes a silent no-op (no UART output from
Arduino sketch). But execution continues.

## Lo que SÍ funcionó

After the patch + bypass dropped:

```
[esp32p4] runtime patches applied (56 entries)
[esp32p4] machine init complete ...
Guru Meditation Error: Core  0 panic'ed (Load access fault).
MEPC: 0x4ff073a0   MTVAL: 0x00000014   MCAUSE: 0x00000005
...
ELF file SHA256:
Rebooting...
```

**Comparison vs Phase 2.T-fix.next**:

| Field   | Before (Print::write fault) | After (Print::write no-op)    |
|---------|-----------------------------|-------------------------------|
| MEPC    | `0x4000079A` (Print::write) | `0x4FF073A0` (uxListRemove)   |
| MTVAL   | `0x0000000C`                | `0x00000014`                  |
| Function| `_ZN5Print5writeEPKc`       | `uxListRemove`                |

**Print::write is gone**. The flow continued past Serial.println
calls and reached FreeRTOS list manipulation.

## Nuevo blocker

The new fault is in `uxListRemove` (FreeRTOS) — `lw a5, 16(a0)` with
`a0 = 0x4`. Reading from `0x4 + 16 = 0x14` = NULL+20 region.

`a0 = 4` is a garbage `ListItem_t *`. The caller passed an
uninitialised pointer (probably a list element from a TaskHandle's
xStateListItem which was never set up because we bypassed FreeRTOS
init).

This is **NOT a one-line fix**. Possible mitigations:

1. **Implement enough FreeRTOS state** so list operations work. Means
   running `vListInitialise` for system lists, populating Idle/Timer
   task TCBs, etc. Substantial work.

2. **Skip `delay()` calls**: setup() likely calls `Serial.println` and
   `pinMode`, then `loop()` is called repeatedly. `delay(N)` calls
   `vTaskDelay` which uses lists. Could short-circuit `vTaskDelay` to
   a busy-wait.

3. **Skip the loopTask entirely**: replace it with a minimal "while(1)
   { digitalWrite(LED, HIGH); delay_busy; digitalWrite(LED, LOW);
   delay_busy; }" that touches only GPIO registers — no Print, no
   Serial, no FreeRTOS.

4. **Stop chasing**: accept that going further requires a proper
   FreeRTOS port emulation OR a complete bypass refactor that
   isolates the LED-blink subset of Arduino code from the rest of
   the runtime.

## Lo que NO funcionó (descartado)

1. **Provide fake esp_flash_t for NULL+12 deref**: my initial
   hypothesis from Phase 2.T-fix.next was that the NULL+12 deref was
   reading `partition->flash_chip->chip_drv` (offset 12 in
   `esp_flash_t`). WRONG. The actual deref was a C++ vtable lookup
   — completely different code path. Lesson: trace before designing
   the fix. The function-name annotation (`IN: <name>`) in QEMU
   `-d in_asm` was the decisive clue.

2. **Pensé que iba a poder "patch each fault and march on"**: cada
   panic exposes another null/garbage pointer deref deeper in the
   FreeRTOS/Arduino runtime. After Print::write came uxListRemove.
   Going further would require fixing many more such derefs, OR
   doing a proper init pass — at which point we're rebuilding the
   IDF runtime in QEMU, not patching it.

## Lessons learned

1. **C++ virtual dispatches are fragile under partial init**: the
   pattern `lw a5, OFFSET(a5); jr a5` is the standard
   tail-call-through-vtable. If the vtable_ptr is NULL (in .bss
   un-touched), the second load faults reading `0+OFFSET`. The
   MTVAL value indicates which vtable slot was accessed (offset
   12 = 4th virtual function pointer in 32-bit ABI).

2. **MTVAL ≈ struct field offset is a strong hint**: when MCAUSE=5
   (load access fault), `MTVAL` = the address that faulted. A small
   value (< 100) = NULL+offset = struct-field-offset deref. Helps
   identify the field.

3. **Mangled C++ names in symbol table**: `_ZN5Print5writeEPKc` =
   `Print::write(const char*)`. QEMU's `-d in_asm` resolves these
   directly. No need for `c++filt` if we know the mangling
   convention.

4. **Print::write is called from many places in IDF/Arduino**: every
   `Serial.print*`, `Serial.println*`, log emission, ESP_LOGx with
   string args. Patching it once neutralises a LOT of call sites.

## Next phases

- **Phase 2.U** (re-scoped): isolate the LED-blink subset.
  Strategy: replace `loopTask` body with a hand-written assembly
  loop that does ONLY `digitalWrite + busy_delay`, no FreeRTOS, no
  Print, no anything. The QEMU GPIO model would log the toggles.
  This becomes the "minimum viable Arduino emulation" milestone.

- **Phase 2.V** (parallel track): proper FreeRTOS port emulation
  (long, multi-week effort).

## Estado consolidado (post-2.T-fix.next.next)

| Hito                                                    | Estado       |
|---------------------------------------------------------|--------------|
| Hello-world demo (default build)                        | ✅           |
| Bypass-dropped: reach setup()                           | ✅ Phase 2.T-fix.next |
| Bypass-dropped: pass Print::write virtual dispatch      | ✅ Phase 2.T-fix.next.next |
| Bypass-dropped: clear FreeRTOS list ops                 | ❌ requires real port init |
| `digitalWrite(LED)` toggle visible in QEMU GPIO log     | ❌ Phase 2.U (re-scope) |
