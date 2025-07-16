import { stringToUint8Array, uint8ArrayToString } from 'uint8array-extras'
import { GenericModule, IGenericModule } from '../RPC/Core.js'
import { encode as msgPackEncode, decode as msgPackDecode } from '@msgpack/msgpack'

export class Converter<I = unknown, O = unknown> extends GenericModule<I, unknown, O, unknown> {
    constructor(
        sources?: IGenericModule<unknown, unknown, I, unknown>[],
        public converter?: (message: I) => O
    ) {
        super('', sources)
    }
    async receive(message: I, source: string, target: string) {
        if (this.converter) await this.send(this.converter(message), source, target)
    }
}

export class JsonStringifier<I extends object> extends Converter<I, string> {
    constructor(sources?: GenericModule<unknown, unknown, I, unknown>[]) {
        super(sources, (msg: I) => JSON.stringify(msg))
    }
}

export class JsonStringifierToUint8Array<I extends object> extends Converter<I, Uint8Array> {
    constructor(sources?: GenericModule<unknown, unknown, I, unknown>[]) {
        super(sources, (msg: I) => stringToUint8Array(JSON.stringify(msg)))
    }
}

export class JsonParser extends Converter<string, object> {
    constructor(sources?: IGenericModule<unknown, unknown, string | Uint8Array, unknown>[]) {
        super(sources, (msg: string | Uint8Array) => {
            let result
            if (typeof msg === 'string') result = JSON.parse(msg)
            else result = JSON.parse(uint8ArrayToString(msg))
            return result
        })
    }
}

export class MsgPackEncoder<I extends object> extends Converter<I, Uint8Array> {
    constructor(sources?: GenericModule<unknown, unknown, I, unknown>[]) {
        super(sources, (msg: I) => msgPackEncode(JSON.parse(JSON.stringify(msg))))
    }
}

export class MsgPackDecoder extends Converter<string | Uint8Array, object> {
    constructor(sources?: IGenericModule<unknown, unknown, string | Uint8Array>[]) {
        super(sources, (msg: string | Uint8Array) => {
            let result = {}
            let received: unknown
            if (typeof msg === 'object') received = msgPackDecode(msg)
            if (typeof received === 'object') result = received as object
            return result
        })
    }
}
