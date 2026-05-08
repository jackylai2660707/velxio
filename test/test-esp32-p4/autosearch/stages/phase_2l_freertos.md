# Phase 2.L — vTaskStartScheduler + FreeRTOS task creation

**Estado**: ✅ done · commit `0cf82e7fd7`

## Goal

Después de Phase 2.K (skip do_system_init_fn + libgcc unwind), la app llegó a `esp_startup_start_app` pero abortaba antes de `vTaskStartScheduler` porque:
1. `esp_crosscore_int_init` falla en `esp_intr_alloc` → ESP_ERROR_CHECK → abort.
2. Una vez bypaseado eso, `vTaskStartScheduler` llama `vApplicationGetIdleTaskMemory` que intenta `pvPortMalloc` → returns NULL (heap no init) → assert loop infinito.

## Fixes (commit `0cf82e7`)

### Fix 1 — esp_crosscore_int_init bypass

Patch `0x40009104`: replace c.beqz (`0xCD15`) con 4-byte `j +60` (`0x03C0006F`). Skipea el error-check failure path siempre, sin importar si esp_intr_alloc returnó error.

### Fix 2 — vApplicationGetIdleTaskMemory static buffers

Reemplaza el body de la función con 7 instrucciones que asignan buffers estáticos en L2MEM `0x4FF60000`:

```asm
lui  t0, 0x4FF60         # static pool base
sw   t0, 0(a0)            # *ppxIdleTaskTCBBuffer  = pool[0..352)
addi t1, t0, 0x400        # t1 = pool + 1024
sw   t1, 0(a1)            # *ppxIdleTaskStackBuffer = pool[1024..2048)
li   t2, 0x400            # t2 = 1024
sw   t2, 0(a2)            # *pulIdleTaskStackSize  = 1024
ret
```

7 patches × 4 bytes = 28 bytes en `0x4FF07042-0x4FF0705D`.

## Resultado

App ejecuta **143 unique functions** (vs 112 antes). Nuevas:
- `xTaskCreatePinnedToCore`, `xTaskCreateStaticPinnedToCore`
- `prvInitialiseNewTask`, `prvAddNewTaskToReadyList`
- `pxPortInitialiseStack` (FreeRTOS port stack init para nuevas tasks)
- `vPortSetupTimer` (FreeRTOS port timer setup)
- `heap_caps_malloc`, `heap_caps_aligned_alloc_base`, `heap_caps_alloc_failed`
- `esp_intr_alloc`, `esp_intr_alloc_intrstatus`, `esp_intr_alloc_intrstatus_bind`
- `vApplicationGetIdleTaskMemory` (now uses our static buffers)

**FreeRTOS scheduler está activamente creando tasks**. La app está EN el flujo de:
1. ✅ vTaskStartScheduler entered
2. ✅ Idle task created (via static buffers)
3. 🚧 Main task creation in progress
4. ⏳ Eventually app_main → setup() → loop()

## Próximo blocker

`heap_caps_alloc_failed` aparece en el trace → eventualmente abort. Significa que algunas mallocs sí están fallando (heap no completamente init).

**Phase 2.L.next** opciones:
1. **Re-enable do_system_init_fn(0)** que llama `heap_caps_init`. Era slow pero con SYSTIMER fix puede ser viable. Necesita esperar 2-5 min wall.
2. **Patchear pvPortMalloc** para usar bump allocator estático (~10 instrucciones).
3. **Provide minimal heap_caps_init** stub que registra una región mínima.

Cualquiera de los tres destrabaría main_task → app_main → setup() → first UART output.

## Estado consolidado

| Métrica | Inicio sesión | Fin sesión |
|---|---|---|
| Funciones IDF runtime ejecutadas | ~30 | **143** |
| Stage del boot | Pre-init early | **FreeRTOS scheduler creating tasks** |
| Distancia a app_main | ~50 layers | **~3 layers** |

Esto es el progreso más grande del proyecto: el emulador pasa de "ROM panica" a "FreeRTOS scheduler running". Una iteración más y vemos el primer UART output.

## Archivos tocados

- `hw/riscv/esp32p4.c`: 9 nuevos runtime patches (1 crosscore bypass + 7 vAppGetIdleTaskMem + 1 leftover).
