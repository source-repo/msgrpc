import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RpcTopologyRecord, TopologyStore } from './Topology.js'

/**
 * The smallest honest durable store: one JSON file, written beside the file it replaces and
 * renamed over it, because rename is the atomicity a single host's topology needs and a database
 * is not. Node-only by its imports, so it is exported from the node index and never the web one -
 * a browser host is volatile by nature and its capabilities record says so.
 */

/** Refused rather than guessed at, per the schema policy: an unknown format is unknown rules. */
const FORMAT = 1

export class JsonFileTopologyStore implements TopologyStore {
    readonly durable = true

    constructor(private readonly path: string) {}

    async load(): Promise<RpcTopologyRecord[] | undefined> {
        let text: string
        try {
            text = await readFile(this.path, 'utf8')
        } catch (e) {
            if ((e as { code?: string }).code === 'ENOENT') return undefined
            throw e
        }
        const parsed = JSON.parse(text) as { format?: number; records?: RpcTopologyRecord[] }
        if (parsed.format !== FORMAT) throw new Error(`topology store ${this.path}: format ${parsed.format} is not ${FORMAT} - this library is older than this file`)
        return parsed.records ?? []
    }

    async save(records: RpcTopologyRecord[]): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true })
        // Written whole and renamed into place: a crash mid-write leaves the previous committed
        // state, never a truncated file that un-fences every epoch it forgot.
        const staging = join(dirname(this.path), `.${Date.now()}-${process.pid}.topology.tmp`)
        await writeFile(staging, JSON.stringify({ format: FORMAT, records }, null, 2), 'utf8')
        await rename(staging, this.path)
    }
}
