import { GenericModule, IGenericModule } from '../RPC/Core.js'

export class Filter<MsgType = unknown> extends GenericModule {
    constructor(
        name: string,
        sources: IGenericModule[],
        public filter: (msg: MsgType) => boolean
    ) {
        super(name, sources)
    }

    async receive(message: MsgType, source: string, target: string) {
        if (this.filter(message)) {
            return await this.send(message, source, target)
        }
    }
}
