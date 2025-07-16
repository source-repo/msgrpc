import EventEmitter from 'events'

export interface ITestRpc extends EventEmitter {
    add: (a: number, b: number) => Promise<number>
    extendBuffer: (b: Uint8Array) => Promise<Uint8Array>
}
