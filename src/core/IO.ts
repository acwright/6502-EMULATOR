export interface IO {

  read(address: number): number
  write(address: number, data: number): void
  tick(frequency: number): number  // Returns interrupt status: bit 7 = IRQ, bit 6 = NMI
  reset(coldStart: boolean): void
  
}