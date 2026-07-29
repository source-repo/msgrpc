import type { ExposeOptions } from './RpcServerHandler.js'

export const defaultWebSocketPort = 3000

export interface IManageRpc {
    exposeClassInstance(instance: object, name?: string, options?: number | ExposeOptions): void
    exposeClass<T>(constructor: new (...args: unknown[]) => T, aliasName?: string): void
    exposeObject(obj: object, name: string): void
    expose(methodName: string, method: () => void): void
    createRpcInstance(className: string, instanceName?: string, ...args: unknown[]): Promise<string | undefined>
}

export const isEventFunction = (prop: string) =>
    prop === 'on' ||
    prop === 'addListener' ||
    prop === 'prependListener' ||
    prop === 'once' ||
    prop === 'prependOnceListener' ||
    prop === 'off' ||
    prop === 'removeListener' ||
    prop === 'emit' ||
    prop === 'removeListener' ||
    prop === 'removeAllListeners' ||
    prop === 'setMaxListeners' ||
    prop === 'getMaxListeners'

export const isPromiseFunction = (prop: string) => prop === 'then' || prop === 'catch'
