# emulator/ — implementación del emulador ESP32-P4 para Velxio

Folder de trabajo para la rama de **emulación**. La investigación inicial vive un nivel arriba en [`../autosearch/`](../autosearch/) y la decisión de no agregar P4 sin emulador queda registrada ahí.

## TL;DR de la decisión

Forkear **`espressif/qemu`** (rama `esp-develop`) y agregar `hw/riscv/esp32p4.c` modelado sobre `esp32c3.c`. Ver [`00_approach_decision.md`](00_approach_decision.md) para el porqué (descartando JS-from-scratch, TinyEMU/rvemu, lcgamboa).

## Estructura

```
emulator/
├── README.md                    # este archivo
├── 00_approach_decision.md      # comparación de las 4 opciones, veredicto
├── 01_phase1_plan.md            # plan accionable Phase 1 (boot + blink + Serial)
├── 02_memory_map.md             # (TODO) tabla del memory map P4 desde TRM Cap 7
├── 03_peripheral_inventory.md   # (TODO) qué peripherals tocar / stubear
├── plan/                        # planes por fase (Phase 2, Phase 3 cuando aplique)
└── reference/                   # snippets/notas extraídas del esp32c3.c upstream
```

## Specs descargados

En [`../specs/`](../specs/):
- `esp32-p4_technical_reference_manual_en.pdf` (21 MB, 3078 páginas)
- `esp32-p4_datasheet_en.pdf` (1.5 MB)
- `esp32-p4_hardware_design_guidelines_en.pdf` (1.8 MB)
- `_TRM_TOC.txt` — index completo del TRM (1713 líneas) para grep rápido

## Próximos pasos inmediatos

1. **Decidir dónde vive el fork**: `third-party/qemu-esp32p4/` (paralelo a `qemu-lcgamboa`) o submodule. Recomendado: `third-party/qemu-esp32p4/` con clone shallow.
2. **Sanity build del C3** primero (`./configure --target-list=riscv32-softmmu && ninja`). Si esto no funciona, el resto no funciona tampoco.
3. **Llenar `02_memory_map.md`** leyendo TRM Cap 7. Esto es el único bloqueante de "información" — todo lo demás se deriva del template de C3.
4. Empezar Phase 1 paso 1 de [`01_phase1_plan.md`](01_phase1_plan.md).
