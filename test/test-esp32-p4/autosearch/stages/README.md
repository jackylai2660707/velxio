# Stages — roadmap ESP32-P4 en QEMU

Tablero de estado: **una fila por fase**, ordenadas. Lo que viene primero es lo que arranco al volver. El detalle por fase está en su archivo individual.

| # | Fase | Estado | Commit | Archivo |
|---|---|---|---|---|
| 0 | Machine scaffold + memmap (TRM Cap 7) | ✅ done | `d7969f4` | [phase_0_scaffold.md](phase_0_scaffold.md) |
| 1.A | UART0 real + `-bios` loader | ✅ done | `24e67a8` | [phase_1a_uart.md](phase_1a_uart.md) |
| 1.B | 22 named peripheral stubs | ✅ done | `c976734` | [phase_1b_stubs.md](phase_1b_stubs.md) |
| 1.C | eFuse + SYSTIMER + GPIO reales | ✅ done | `b9abf37` | [phase_1c_efuse_systimer_gpio.md](phase_1c_efuse_systimer_gpio.md) |
| 1.D | `-kernel` ELF loader + extflash + trampolín | ✅ done | `cd03e7a` | [phase_1d_elf_loader.md](phase_1d_elf_loader.md) |
| 1.E | SP init + CSRs custom + ROM ret-fill + PF_X overlay | ✅ done | `b0c4aad` | [phase_1e_unblocks.md](phase_1e_unblocks.md) |
| 1.E.bis | `-bios` acepta ELF + ROM oficial Espressif + trampolín relocalizado | ✅ done | `e05e201` | [phase_1e_bis_rom_loader.md](phase_1e_bis_rom_loader.md) |
| 1.F-lite | RVA+RVF + CLIC MMIO + flash bypass + smart sysreg stubs | ✅ done | `fe94cea` | [phase_1f_lite_unblocks.md](phase_1f_lite_unblocks.md) |
| 1.F.bis | More smart-stub overrides + runtime patches → spi_flash_cache_enabled | ✅ done | `d4505f8` | [phase_1f_bis_more_unblocks.md](phase_1f_bis_more_unblocks.md) |
| 1.F.ter | `__assert_func` no-op patch → past cache asserts, into regi2c spin | ✅ done | `19537aa` | [phase_1l_iterative_patches.md](phase_1l_iterative_patches.md) |
| 1.F | SPI flash controller real (P4 no tiene uno separado — ver lite) | ⏸️ N/A | — | [phase_1f_spi_flash.md](phase_1f_spi_flash.md) |
| 1.G | Cache MMU (flash window translation) | ⏳ pending | — | [phase_1g_cache_mmu.md](phase_1g_cache_mmu.md) |
| 1.H | TIMG con WDT auto-disable | ⏳ pending | — | [phase_1h_timg_wdt.md](phase_1h_timg_wdt.md) |
| 1.I | HP_SYSREG + Reset/Clock real (smart stub ya cubre lo crítico) | ⏳ pending | — | [phase_1i_hp_sysreg.md](phase_1i_hp_sysreg.md) |
| 1.J | RNG, eFuse extendido, segundo HP core | ⏳ pending | — | [phase_1j_misc.md](phase_1j_misc.md) |
| **1.K** | **Interrupt Matrix + UART real-completo (IRQ wiring)** | ⏭️ **next** | — | [phase_1k_uart_full.md](phase_1k_uart_full.md) |
| 1.L | **iterative-patch loop** — 50+ patches needed para llegar a app_main | ⏳ pending | — | [phase_1l_iterative_patches.md](phase_1l_iterative_patches.md) |
| 2 | Arduino blink visible end-to-end | ⏳ pending | — | [phase_2_blink.md](phase_2_blink.md) |
| 3 | Peripherals avanzados (I2C, SPI master, LEDC, ADC, RMT) | ⏳ pending | — | [phase_3_advanced.md](phase_3_advanced.md) |
| 4 | Integración Velxio backend (`esp_qemu_manager.py`) | ⏳ pending | — | [phase_4_velxio_integration.md](phase_4_velxio_integration.md) |
| 5 | LP core + USB Serial/JTAG | ⏳ later | — | [phase_5_lp_core.md](phase_5_lp_core.md) |

**Out of scope (no planeado):**
- MIPI-CSI / MIPI-DSI / ISP / JPEG / H264 codec
- USB OTG HS bus emulation
- Full crypto accelerators (AES/SHA/RSA/HMAC fuera de stubs RW)

## Cómo usar este folder al volver

1. Abrir este README.
2. Mirar la fila marcada "**next**".
3. Abrir el `.md` correspondiente — tiene goal, acceptance criteria, archivos a tocar, y próximos pasos concretos.
4. Cuando termine la fase, mover el "next" a la próxima fila y actualizar la columna Commit.

## Convenciones

- ✅ done — fase implementada + commit landeado + verificación pasó.
- ⏭️ next — la próxima a tocar, con plan ya escrito.
- ⏳ pending — definida en archivo pero sin trabajo aún.
- 🚧 in-progress — work in progress (commit no pusheado todavía).
- ❌ blocked — depende de algo externo.

Cada archivo de fase tiene:
- **Goal** — qué se completa cuando esta fase está done.
- **Acceptance criteria** — cómo verifico que está done.
- **Archivos a tocar** — paths concretos.
- **Pasos** — checklist accionable.
- **Notes** — cosas que me olvido siempre.

Para evitar drift entre `IMPL_STATUS.md` (cronológico, narrativo) y este folder (estructurado, accionable):
- `IMPL_STATUS.md` cuenta la historia en orden cronológico, lo que ya pasó.
- `stages/` es el plan, ordenado por dependencia, lo que va a pasar.
- Después de completar una fase: actualizar AMBOS (commit en `IMPL_STATUS.md`, status flip en `stages/README.md`).
