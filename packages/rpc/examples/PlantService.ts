import EventEmitter from 'events'
import { rpc, rpcNamespace } from '@source-repo/rpc'

/**
 * The service classes. These are the contract: `source-rpc extract` reads this file and writes
 * msgrpc.types.json, which the server validates against and the console renders.
 */

export interface Limits {
    min: number
    max: number
    /** Absent means the loop has never been commissioned. */
    commissioned?: Date
}

@rpcNamespace('plant', { version: '1' })
export class Plant extends EventEmitter {
    /** Declared rather than inferred from emit() calls, which cannot be read statically. */
    declare rpcEvents: { setpointChanged: [value: number]; alarm: [message: string, severity: number] }

    private setpoint = 0
    private limits: Limits = { min: 0, max: 2000 }

    @rpc
    async readSetpoint(): Promise<number> {
        return this.setpoint
    }

    @rpc
    async writeSetpoint(value: number, mode?: 'auto' | 'manual'): Promise<number> {
        if (value > this.limits.max) {
            this.emit('alarm', `${mode ?? 'manual'} setpoint ${value} above limit ${this.limits.max}`, 2)
            return this.setpoint
        }
        this.setpoint = value
        this.emit('setpointChanged', value)
        return value
    }

    @rpc
    async configure(limits: Limits): Promise<Limits> {
        this.limits = limits
        return limits
    }

    /** Not marked, so it is not reachable however a caller addresses it. */
    async resetToFactoryDefaults() {
        this.setpoint = 0
    }
}

@rpcNamespace('history', { version: '1' })
export class History {
    private samples: { at: Date; value: number }[] = []

    record(value: number) {
        this.samples.push({ at: new Date(), value })
        if (this.samples.length > 500) this.samples.shift()
    }

    @rpc
    async recent(count: number): Promise<{ at: Date; value: number }[]> {
        return this.samples.slice(-count)
    }

    @rpc
    async summary(): Promise<{ samples: number; latest: number | null }> {
        return { samples: this.samples.length, latest: this.samples.at(-1)?.value ?? null }
    }
}
