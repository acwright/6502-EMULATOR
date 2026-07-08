export class ROM {
  
  static START: number = 0x8000
  static END: number = 0xFFFF
  static CODE: number = 0xA000
  static SIZE: number = ROM.END - ROM.START + 1

  data: number[] = [...Array(ROM.SIZE)].fill(0x00)

  read(address: number): number {
    return this.data[address]
  }

  load(data: number[]): void {
    if (data.length != ROM.SIZE) { return }

    this.data = data
  }
}