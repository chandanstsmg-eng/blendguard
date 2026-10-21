// @serialport/binding-mock ships types its package.json "exports" does not point to; this is the part the tests use.
declare module '@serialport/binding-mock' {
  import type { BindingInterface, BindingPortInterface, OpenOptions } from '@serialport/bindings-interface';
  export interface MockPortBinding extends BindingPortInterface {
    emitData(data: Buffer | string): void;
    write(buffer: Buffer): Promise<void>;
  }
  export const MockBinding: BindingInterface<MockPortBinding, OpenOptions> & {
    reset(): void;
    createPort(path: string, options?: { echo?: boolean; record?: boolean; readyData?: Buffer }): void;
  };
}
