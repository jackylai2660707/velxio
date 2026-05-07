# Phase 2.A.5 — Flash bootloader load (invalid header)

**Estado**: ⏭️ next · necesita cache MMU real

## Goal

ROM ahora ejecuta `ets_run_flash_bootloader` y trata de leer el header del bootloader desde el cache window. Imprime `invalid header: 0x0b000ec1` repetidamente.

## Análisis

- Flash blob `blink.merged.bin` tiene `0xFF` en offset 0..0x1FFF (erased) y bootloader magic `0xE9` en offset `0x2000`.
- ROM lee primer header desde `cache_window @ 0x40000000` que mapea a flash offset 0.
- `0x0b000ec1` es lo que la cache devuelve al leer flash en offset 0 (probablemente algún garbage uninitialized o un read across boundary).

## Análisis del flujo (confirmado por disasm)

`ets_run_flash_bootloader @ 0x4FC04762`:
1. Llama `ROM_Boot_Cache_Init` que ejecuta `Cache_FLASH_MMU_Init`. Este invalida los 1024 entries del MMU (escribe 0 a `0x5008C37C` con index 0..1023 vía `0x5008C380`).
2. Llama `ets_loader_map_range(buffer=sp+4, offset=0x2000, size=24, secure=0)`. Esta función debe:
   - Programar el MMU para mapear flash[0x2000, 0x2000+24) a una virtual address en cache window.
   - Devolver esa virtual address.
3. Caller hace `memcpy(sp+12, mapped_va, 8)` y verifica `*(uint8_t*)mapped_va == 0xE9` (magic).

## Causa raíz

El MMU del flash cache está modelado como **smart stub scratch RW** (sólo guarda lo escrito, sin lógica). Las escrituras a `0x5008C37C/380` quedan en el storage pero **el cache window en `0x40000000` no responde a esas configuraciones**. En el setup actual de QEMU:
- El flash blob de `blink.merged.bin` se carga directo a RAM en `0x40000000` (linear: flash byte 0 → 0x40000000, flash byte 0x2000 → 0x40002000).
- `ets_loader_map_range` programa el MMU pero la translación no se ejecuta.
- Si la función devuelve un VA que asume un mapping específico (no linear), el `memcpy` lee de un VA que no está mapeado a flash[0x2000].

`0x0b000ec1` no aparece en la flash blob a ningún offset; probablemente es **stack garbage** que ets_loader_map_range devolvió cuando el MMU set falló.

## Plan de implementación

Phase 2.A.5 requiere un **cache MMU emulator real**:

1. **NO** cargar el flash blob directo a RAM en `0x40000000`. Cargar el blob a un MemoryRegion separado (RAM-backed) que solo es accesible vía el MMU.
2. Implementar el cache window (`0x40000000-0x40FFFFFF`) como **MMIO region** que en cada read:
   - Calcula `page_index = (vaddr - 0x40000000) >> 16` (64KB pages).
   - Lee el MMU entry para `page_index`.
   - Si entry es válido (bit 14 set per TRM): `flash_page = entry & 0x3FFF`.
   - Devuelve `flash_blob[flash_page * 0x10000 + (vaddr & 0xFFFF)]`.
3. Decodificar las escrituras a `0x5008C37C` (entry value) y `0x5008C380` (entry index) en una tabla `mmu_entries[1024]`.
4. Cuando `Cache_FLASH_MMU_Init` invalida todo, todas las entries quedan en 0 (invalid). Antes de usar el cache, ROM debe llamar `Cache_FLASH_MMU_Set` que programa la mapping.

### Referencia TRM

- TRM Cap 7.3.3 "External Memory" — Cache MMU.
- IDF `cache_ll.h` `cache_ll_l1_set_mmu_invalid_entry`.
- esp-rom-elfs `Cache_MSPI_MMU_Set` source.

## Acceptance criteria

- [ ] ROM imprime `bootloader header valid` o equivalent → continúa booteando.
- [ ] No más `invalid header` repeated.

## Pasos

1. Disassembly de `ets_run_flash_bootloader` y `0x4fc0e716` (la función que lee el header).
2. Determinar offset que ROM espera.
3. Si el blob está mal: regenerar O patchear cache window para mapear correctly.
4. Validar fix con run.

## Archivos a tocar

- `hw/riscv/esp32p4.c` — posible cache window mapping fix.
- O regenerar `blink.merged.bin` con offset correcto.

## Notas

- Esto es **flash content / cache MMU** territory, no más CPU/peripheral emulation.
- Cuando esto se desbloquee el bootloader Arduino correrá → app code → `setup()` y `loop()` Arduino → LED blink. Eso es Phase 2 (blink end-to-end).
