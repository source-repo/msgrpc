import { GenericModule, IGenericModule } from '../RPC/Core.js'

export interface ITryCatch<MsgType = unknown> {
    on(event: 'caught', handler: (message: MsgType, error: unknown) => void): this
    emit(event: 'caught', message: MsgType, error: unknown): boolean
    removeListener(event: 'caught', handler: (message: MsgType, error: unknown) => void): this
}

export class TryCatch extends GenericModule implements ITryCatch<unknown> {
    constructor(sources: IGenericModule[]) {
        super('', sources)
    }

    override async receive(message: unknown, source: string, target: string) {
        // 'caught' is the event this module's own interface declares. It emitted 'Caught exception',
        // which no listener written against ITryCatch could ever have been registered for, so every
        // error this module existed to surface was swallowed.
        await this.send(message, source, target).catch((e) => this.emit('caught', message, e))
    }
}
