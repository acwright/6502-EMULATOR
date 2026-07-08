import { IO } from '../IO'

export class Empty implements IO {

  read(address: number): number {
    return 0
  }

  write(address: number, data: number): void {}
  tick(frequency: number): number { return 0 }
  reset(coldStart: boolean): void {}

}
