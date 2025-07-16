import { GenericModule, IGenericModule, Message } from '../RPC/Core.js'

/**
 * Sends received messages to the correct target.
 * If a message is sent to a target which doesn't exist, a TargetNotFoundError is thrown.
 */
export class Switch extends GenericModule {
    targets = new Map<string, IGenericModule>()

    constructor(
        sources: IGenericModule[],
        public getTarget?: (target: string) => IGenericModule
    ) {
        super('', sources)
    }

    async receive(message: Message, source: string, target: string) {
        let switchTarget: IGenericModule | undefined
        if (this.getTarget) switchTarget = this.getTarget(target)
        if (!switchTarget) switchTarget = this.targetExists(target)
        if (!switchTarget) switchTarget = super.targetExists(target)
        if (switchTarget) await switchTarget.receive(message, source, target)
        return
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

    targetExists(name: string, level: number = 0) {
        let result: IGenericModule | undefined
        this.targets.forEach((target) => {
            if (!result && !target.isTransport() && target.targetExists(name, level + 1)) result = target
        })
        return result
    }
}
