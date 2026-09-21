# Flash Cart — a banked AC6502 sample cartridge.
#
# Needs cc65 (`brew install cc65`). The built `FlashCart.crt` is committed, so
# the golden suite boots it without a toolchain; rebuilding it moves every
# golden captured from it and is a deliberate act, in a commit of its own.

TARGET = FlashCart
CONFIG = flash-cart

.PHONY: all view run clean

all: $(TARGET).crt

$(TARGET).crt: $(TARGET).asm $(CONFIG).cfg
	cl65 -t none -C $(CONFIG).cfg -l $(TARGET).lst -o $@ $(TARGET).asm

view: $(TARGET).crt
	hexdump -C $(TARGET).crt

# Run it in the emulator built from this repository.
run: $(TARGET).crt
	cd ../.. && npm run cli -- run --cart samples/flash-cart/$(TARGET).crt

clean:
	rm -f $(TARGET).crt $(TARGET).lst
