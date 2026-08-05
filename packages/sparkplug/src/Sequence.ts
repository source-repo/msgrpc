const SPARKPLUG_SEQUENCE_MODULUS = 256

function normalizeSequence(value: number): number {
    if (!Number.isInteger(value)) throw new Error('sequence must be an integer')
    return ((value % SPARKPLUG_SEQUENCE_MODULUS) + SPARKPLUG_SEQUENCE_MODULUS) % SPARKPLUG_SEQUENCE_MODULUS
}

export class SparkplugSequence {
    #next: number

    constructor(initial = 0) {
        this.#next = normalizeSequence(initial)
    }

    next(): number {
        const value = this.#next
        this.#next = normalizeSequence(this.#next + 1)
        return value
    }

    peek(): number {
        return this.#next
    }
}

export class SparkplugBirthDeathSequence {
    #next: number

    constructor(initial = 0) {
        this.#next = normalizeSequence(initial)
    }

    claimBirth(): SparkplugBirthDeathClaim {
        const value = this.#next
        this.#next = normalizeSequence(this.#next + 1)
        return { bdSeq: value }
    }

    peek(): number {
        return this.#next
    }
}

export interface SparkplugBirthDeathClaim {
    readonly bdSeq: number
}
