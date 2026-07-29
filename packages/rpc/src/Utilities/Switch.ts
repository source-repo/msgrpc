import { GenericModule, IGenericModule, Message, TransportEvent } from '../RPC/Core.js'

/**
 * Sends received messages to the correct target.
 * A message whose target cannot be resolved is dropped.
 */
export class Switch extends GenericModule {
    targets = new Map<string, IGenericModule>()

    constructor(
        sources: IGenericModule[],
        public getTarget?: (target: string) => IGenericModule
    ) {
        super('', sources)
    }

    override async receive(message: Message, source: string, target: string) {
        let switchTarget: IGenericModule | undefined
        if (this.getTarget) switchTarget = this.getTarget(target)
        if (!switchTarget) switchTarget = this.targetExists(target)
        if (!switchTarget) switchTarget = super.targetExists(target)
        if (!switchTarget) {
            // Reported *and* refused. Reporting alone was not enough: the sender's promise still
            // resolved, so a caller learned nothing until its own timeout expired ten seconds later
            // with nothing to explain it - and the frame had been dropped here all along.
            //
            // The usual way to arrive here is calling a peer the moment ready() resolves. ready()
            // means this peer's links are up, not that anyone else has announced themselves over
            // them, and presence lands a moment later. Under load that moment is long enough to
            // lose the race. RpcServerBase.awaitPeer is the wait that closes it.
            this.emit(TransportEvent.unroutable, { source, target, reason: 'no switch target for this peer' })
            throw new Error(
                `no route to '${target}': nothing here reaches that peer. If it has only just connected, its presence may not have arrived yet - await it before calling.`
            )
        }
        await switchTarget.receive(message, source, target)
    }

    /**
     * Add a target for the switch.
     * @param target The module to send the messages to.
     * @param identifier A unique identifier for this target.
     * @returns A function which can be called to remove this target.
     */
    public setTarget(target: IGenericModule, identifier?: string) {
        const getNameFromMod = (mod: IGenericModule) => {
            const result = mod.getName()
            return result
        }
        const targetName = identifier === undefined ? getNameFromMod(target) : identifier
        this.targets.set(targetName, target)
        let deleted = false
        return () => {
            if (deleted) {
                return
            }
            deleted = true
            this.targets.delete(targetName)
        }
    }

    public setTargets(targets: IGenericModule[]) {
        for (const target of targets) this.setTarget(target)
    }

    override targetExists(name: string, level: number = 0) {
        let result: IGenericModule | undefined
        this.targets.forEach((target) => {
            if (!result && !target.isTransport() && target.targetExists(name, level + 1)) result = target
        })
        return result
    }
}
