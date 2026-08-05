import type { DescribedNamespace, PeerStructure } from './types'

const acronyms: { [word: string]: string } = {
    ai: 'AI',
    api: 'API',
    emqx: 'EMQX',
    hmi: 'HMI',
    mcp: 'MCP',
    mqtt: 'MQTT',
    rpc: 'RPC',
    sdk: 'SDK',
    std: 'Std',
    ui: 'UI'
}

const generatedPrefixes = new Set(['console', 'mcp', 'page'])

const words = (id: string) => id.split(/[-_.:/\s]+/).filter(Boolean)

const titleWord = (word: string) => acronyms[word.toLowerCase()] ?? `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`

export const displayNameForId = (id: string) => {
    const parts = words(id)
    if (parts.length >= 4 && generatedPrefixes.has(parts[0].toLowerCase())) return titleWord(parts[0])
    return parts.map(titleWord).join(' ') || id
}

export const peerDisplayName = (peer: string, structure?: PeerStructure) => {
    const label = structure?.label?.trim()
    if (label) return label
    const place = structure?.place?.map((part) => part.trim()).filter(Boolean)
    if (place?.length) return place[place.length - 1]
    return displayNameForId(peer)
}

export const namespaceDisplayName = (namespace: DescribedNamespace) => namespace.topology?.label?.trim() || displayNameForId(namespace.name)
