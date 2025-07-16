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

    async receive(message: unknown, source: string, target: string) {
        this.send(message, source, target)
            .then()
            .catch((e) => this.emit('Caught exception', message, e))
    }
}
