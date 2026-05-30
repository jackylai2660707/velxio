#!/usr/bin/env bash
# Phase 2.DO — run the AES-GCM DMA self-test.
set -u
ROM=/mnt/c/Desarrollo/velxio/third-party/esp-rom-elfs/esp32p4_rev0_rom.elf
FW=/mnt/c/Desarrollo/velxio/test/test-esp32-p4/sketches/blink/build/esp32.esp32.esp32p4/blink.ino.merged.bin
QEMU="$HOME/qemu-p4-build/qemu-system-riscv32"
export VELXIO_GPIO_LOG=/tmp/gcm_events.jsonl
rm -f /tmp/gcm_events.jsonl /tmp/gcm_stderr.txt

timeout 5 "$QEMU" -M esp32p4 -bios "$ROM" \
  -drive file="$FW",if=mtd,format=raw -nographic \
  >/tmp/gcm_stdout.txt 2>/tmp/gcm_stderr.txt

echo "=== AES-GCM self-test ==="
grep -i "esp32p4.aes\] self-test GCM" /tmp/gcm_stderr.txt | head
echo "=== GCM op lines ==="
grep -iE "esp32p4.aes\] op#.*GCM" /tmp/gcm_stderr.txt | head
echo "=== regression (AES-DMA ECB/CBC + AXI-DMA) ==="
grep -iE "self-test DMA: ECB128|axi_dma\] self-test A" /tmp/gcm_stderr.txt | head -2
