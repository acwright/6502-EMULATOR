import { IO } from '../IO'

export class Empty implements IO {

  raiseIRQ = () => {}
  raiseNMI = () => {}

  read(address: number): number {
    return 0
  }

  write(address: number, data: number): void {}
  tick(frequency: number): void {}
  reset(coldStart: boolean): void {}

}
