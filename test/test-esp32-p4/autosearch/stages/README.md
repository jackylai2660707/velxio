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
| **2** | **PROFESSIONAL ROADMAP** — implementación completa sin hacks | 🚧 wip | — | [PHASE_2_PROFESSIONAL_ROADMAP.md](PHASE_2_PROFESSIONAL_ROADMAP.md) |
| 2.A.1 | Flash blob via `-drive if=mtd` + ROM ret-fill sync write | ✅ done | `07ac21b` | (see roadmap) |
| 2.A.2 | Cache/MSPI smart stubs + ROM patch → **UART output real** | ✅ done | `4253b3e` | (see roadmap) |
| 2.A.3 | Section-data pass + reset-cause/strap overrides → **full ROM banner** | ✅ done | `780ad0c` | [phase_2a3_section_data_banner.md](phase_2a3_section_data_banner.md) |
| 2.A.4 | `_init` skip-unpack-clear patch → **ROM advances to CLIC** | ✅ done | `db700e4` | [phase_2a4_runtime_overwrite.md](phase_2a4_runtime_overwrite.md) |
| 2.D | CLIC backing-RAM + Cache freeze mirrors → **ROM reaches bootloader** | ✅ done | `3a1e6ed` | [phase_2d_clic_cache.md](phase_2d_clic_cache.md) |
| 2.A.5 | `ets_loader_map_range` patch + flash blob reload → **ROM jumps to bootloader entry** | ✅ done | (this commit) | [phase_2a5_bootloader_load.md](phase_2a5_bootloader_load.md) |
| 2.B.regi2c | LPPERI clock-enable + regi2c done bit → **bootloader runs 6.4s of init** | ✅ done | (this commit) | [phase_2b_regi2c.md](phase_2b_regi2c.md) |
| 2.B.boot_comm | Cache MMU block 63 emulator → **chip ID check passes!** | ✅ done | `64e2cd2` | [phase_2b_boot_comm.md](phase_2b_boot_comm.md) |
| 2.B.post_qio (perf) | MMU refactor to eager-copy → **5x faster boot progress** | ✅ done | `947fba8` | [phase_2b_post_qio.md](phase_2b_post_qio.md) |
| 2.I.sha (stub) | Crypto block stubs + SHA_BUSY=0 → ROM `ets_sha_*` returns | ✅ done | `5706e8c` | [phase_2i_sha.md](phase_2i_sha.md) |
| 2.J | `-kernel` ELF path + magic check bypass → **app reaches pmu_hp_system_init** | ✅ done | `887d5d1` | [phase_2j_kernel_elf.md](phase_2j_kernel_elf.md) |
| 2.J.next | CPU1 wait loop bypass → **app runs through call_start_cpu0 + ~30 init fns** | ✅ done | `1f06095` | [phase_2j_kernel_elf.md](phase_2j_kernel_elf.md) |
| 2.J.uart | Investigación: app NOT stuck, ejecutando lento. Requiere scheduler/interrupts. | ✅ analyzed | `adeb86f` | [phase_2j_kernel_elf.md](phase_2j_kernel_elf.md) |
| 2.K.systimer | SYSTIMER OP_REG snapshot protocol — exits IDF poll loops | ✅ done | `e408a19` | [phase_2k_systimer.md](phase_2k_systimer.md) |
| 2.K.init_skip | Skip do_system_init_fn → app reaches **C++ static init + pthread + FreeRTOS port** | ✅ done | `53f8358` | [phase_2k_init_skip.md](phase_2k_init_skip.md) |
| 2.K.frame_info | Skip `__register_frame_info` libgcc DWARF init → reach `vTaskStartScheduler` | ✅ done | `ce6110f` | [phase_2k_init_skip.md](phase_2k_init_skip.md) |
| 2.L | Crosscore err bypass + static idle-task buffers → **xTaskCreate + heap_caps + intr_alloc** | ✅ done | `0cf82e7` | [phase_2l_freertos.md](phase_2l_freertos.md) |
| 2.L.next | Bump allocator + vSystimerSetup bypass → **vTaskStartScheduler runs end-to-end** | ✅ done | `08e104d` | [phase_2l_next_bumpalloc.md](phase_2l_next_bumpalloc.md) |
| 2.M | Bypass scheduler → **main_task + app_main + initArduino executing** | ✅ done | `e555e8c` | [phase_2m_bypass_scheduler.md](phase_2m_bypass_scheduler.md) |
| 2.N | Inline UART writer in app_main → **🎉 "Hello from QEMU ESP32-P4!" 🎉** | ✅ done | `a216796` | [phase_2n_hello_world.md](phase_2n_hello_world.md) |
| 2.O | SYSTIMER 100 Hz tick → CPU IRQ_M_EXT (foundation for FreeRTOS) | ✅ done | `94f989a` `bf7cb47` | [phase_2o_clic_irq.md](phase_2o_clic_irq.md) |
| 2.P | **Investigated**: dropped Phase 2.N → app stuck same as before. Trap to mtvec not firing despite IRQ wiring + CSR enables. Hello-world demo re-enabled. | 🔬 done w/ findings | (this commit) | [phase_2p_real_arduino_attempt.md](phase_2p_real_arduino_attempt.md) |
| 2.Q | **Instrumented esp_cpu IRQ dispatch → root cause: `mtvec=0` when first trap fires (bypass skipped IDF mtvec setup); first trap clears mstatus.MIE permanently.** | ✅ done w/ findings | (this commit) | [phase_2q_irq_diagnostics.md](phase_2q_irq_diagnostics.md) |
| 2.R | **mret stub at `0x4FC1FFB0` + trampoline writes mtvec → end-to-end IRQ delivery validated.** mstatus stable at 0x1888 (MIE=1) across continuous SYSTIMER ticks. | ✅ done | (this commit) | [phase_2r_mtvec_stub.md](phase_2r_mtvec_stub.md) |
| 2.S | **CLIC mode dispatch in `target/riscv/`**: override `write_mtvec` to accept mode 3, dispatch via `*(mtvt + cause*4)`, route SYSTIMER to free cause 17. IDF `_interrupt_handler` now runs on every tick. | ✅ done | (this commit) | [phase_2s_clic_mode.md](phase_2s_clic_mode.md) |
| 2.T | **Investigated**: bypass-dropped flow stuck in `esp_ota_get_running_partition` ESP_LOGE retry loop because `esp_partition_find` returns NULL (partition list empty). NOT a Cache MMU issue (eager-copy works fine). HP_SYS_CLKRST clock-update override verified working. | 🔬 done w/ findings | (prior commit) | [phase_2t_partition_blocker.md](phase_2t_partition_blocker.md) |
| 2.T-fix | **Function-entry stub** at `0x4000549C` returns pointer to fake `esp_partition_t` at `0x4FFA0030`. Bypass-dropped flow now reaches IDF panic handler full register dump (huge progress). New blocker: instruction fetch fault to `0x3FFFF820` (likely fake-struct field deref). | ✅ done | (prior commit) | [phase_2t_fix_partition_stub.md](phase_2t_fix_partition_stub.md) |
| 2.T-fix.next | **Phase 2.M typo fix**: `0xFA4FC06F` → `0xFA5FC06F` (1-bit `imm[11]` error in JAL encoding). Was jumping to `0x3FFFF820` instead of intended `0x40000020 (setup())`. Now bypass-dropped flow reaches setup(), panic handler completes full output incl. Reboot sequence. | ✅ done | (prior commit) | [phase_2t_fix_next_typo.md](phase_2t_fix_next_typo.md) |
| 2.T-fix.next.next | **Print::write virtual dispatch neutralised** at `0x4000079A` (NULL vtable). New blocker: `uxListRemove` called with garbage pointer (FreeRTOS state corruption from skipped scheduler init). Each subsequent fault is deeper in FreeRTOS — single-patch chain not viable. | ✅ done w/ findings | (prior commit) | [phase_2t_fix_next_next_print_write.md](phase_2t_fix_next_next_print_write.md) |
| 2.U | **🎉 LED BLINK MILESTONE** — hand-rolled asm at end of hello-world bypass toggles GPIO pin 5 at ~80 Hz. Dual-peripheral demo (UART + GPIO concurrently). GPIO model patched to use `fprintf(stderr)` for default visibility. | ✅ done | (this commit) | [phase_2u_led_blink.md](phase_2u_led_blink.md) |
| **2.V** | **Real FreeRTOS port emulation** (long multi-week effort, parallel track) — would unblock natural setup()/loop() flow | ⏭️ **next** | — | TBD |
| 2.W | Multi-pin GPIO + input handling (button press → ISR) | ⏳ planned | — | TBD |
| 2.V | `mnxti`/`mintstatus` real semantics (multi-level preemption) | ⏳ planned | — | TBD |
| 2.B | TIMG real (timers + WDT) | ⏳ pending | — | (see roadmap) |
| 2.C | HP_SYSREG + Reset/Clock real | ⏳ pending | — | (see roadmap) |
| 2.D | CLIC + Interrupt Matrix | ⏳ pending | — | (see roadmap) |
| 2.E | eFuse extended (chip rev, BLK0) | ⏳ pending | — | (see roadmap) |
| 2.F | SYSTIMER complete | ⏳ pending | — | (see roadmap) |
| 2.G | GPIO + IO MUX full | ⏳ pending | — | (see roadmap) |
| 2.H | UART complete (5 ports + IRQ) | ⏳ pending | — | (see roadmap) |
| 2.I | RNG + USB Serial/JTAG + crypto | ⏳ pending | — | (see roadmap) |
| 2.J | Multi-core HP + LP | ⏳ pending | — | (see roadmap) |
| 2.K | I2C, SPI master, LEDC, ADC, RMT | ⏳ pending | — | (see roadmap) |
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
