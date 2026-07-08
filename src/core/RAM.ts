export class RAM {
  
  static START: number = 0x0000
  static END: number = 0x7FFF
  static SIZE: number = RAM.END - RAM.START + 1

  data: number[] = [...Array(RAM.SIZE)].fill(0x00)

  read(address: number): number {
    return this.data[address]
  }

  write(address: number, data: number): void {
    this.data[address] = data
  }

  reset(coldStart: boolean): void {
    if (coldStart) {
      this.data.fill(0x00)
    }
  }
  
}