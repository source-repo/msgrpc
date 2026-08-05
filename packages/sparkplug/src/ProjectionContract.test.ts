import test from 'ava'
import { SparkplugDataType } from './Types.js'
import { compileSparkplugProjectionContract, validateSparkplugProjectionContract } from './ProjectionContract.js'

const contract = {
    $schema: './node_modules/@source-repo/sparkplug/sparkplug.projection.schema.json',
    schema: 1,
    groupId: 'plant-a',
    edgeNodeId: 'source-rpc-gateway',
    devices: [
        {
            deviceId: 'pump-7',
            source: { peer: 'pump-controller', component: 'pump' },
            maxPublishHz: 20,
            metrics: [
                {
                    name: 'State/Temperature',
                    path: 'state.temperature',
                    datatype: 'Double',
                    qualityPath: 'state.temperatureQuality',
                    unit: 'degC',
                    minimum: -40,
                    maximum: 180,
                    deadband: 0.1
                },
                { name: 'Properties/Tag', path: 'props.tag', datatype: 'String' }
            ]
        },
        {
            deviceId: 'motor-2',
            source: { peer: 'motor-controller', component: 'motor' },
            metrics: [{ name: 'State/Running', path: 'state.running', datatype: 'Boolean' }]
        }
    ]
}

test('projection contracts normalize order and allocate aliases across the Edge Node', (t) => {
    const compiled = compileSparkplugProjectionContract(contract)

    t.deepEqual(
        compiled.devices.map((device) => ({
            deviceId: device.deviceId,
            metrics: device.mappings.map((metric) => ({ name: metric.name, alias: metric.alias, datatype: metric.datatype }))
        })),
        [
            { deviceId: 'motor-2', metrics: [{ name: 'State/Running', alias: 1, datatype: SparkplugDataType.Boolean }] },
            {
                deviceId: 'pump-7',
                metrics: [
                    { name: 'Properties/Tag', alias: 2, datatype: SparkplugDataType.String },
                    { name: 'State/Temperature', alias: 3, datatype: SparkplugDataType.Double }
                ]
            }
        ]
    )
    t.regex(compiled.hash, /^[a-f0-9]{64}$/)
    t.is(compiled.devices[1]?.maxPublishHz, 20)
    t.is(compiled.devices[1]?.mappings[1]?.deadband, 0.1)
    t.is(compiled.devices[1]?.mappings[1]?.qualityPath, 'state.temperatureQuality')
})

test('projection hash and aliases do not depend on authoring order', (t) => {
    const reordered = {
        edgeNodeId: contract.edgeNodeId,
        devices: [...contract.devices]
            .reverse()
            .map((device) => ({ ...device, source: { component: device.source.component, peer: device.source.peer }, metrics: [...device.metrics].reverse() })),
        groupId: contract.groupId,
        schema: contract.schema
    }
    const first = compileSparkplugProjectionContract(contract, { sourceContractFragments: { state: { temperature: 'number' }, props: { tag: 'string' } } })
    const second = compileSparkplugProjectionContract(reordered, { sourceContractFragments: { props: { tag: 'string' }, state: { temperature: 'number' } } })

    t.is(first.hash, second.hash)
    t.deepEqual(
        first.devices.flatMap((device) => device.mappings.map((metric) => metric.alias)),
        second.devices.flatMap((device) => device.mappings.map((metric) => metric.alias))
    )
    t.is(
        compileSparkplugProjectionContract(contract).hash,
        compileSparkplugProjectionContract({
            ...contract,
            devices: contract.devices.map((device) => ({
                ...device,
                metrics: device.metrics.map((metric) => ({ ...metric, nullable: false, historical: false, transient: false }))
            }))
        }).hash
    )
    t.not(first.hash, compileSparkplugProjectionContract(contract, { sourceContractFragments: { state: { temperature: 'string' } } }).hash)
})

test('projection contracts fail closed on typos and unsafe paths', (t) => {
    t.throws(() => validateSparkplugProjectionContract({ ...contract, edgeNodeID: 'typo' }), { message: /edgeNodeID is not a supported property/ })
    t.throws(
        () =>
            validateSparkplugProjectionContract({
                ...contract,
                devices: [{ ...contract.devices[0], metrics: [{ name: 'Unsafe', path: 'state.__proto__.value', datatype: 'Double' }] }]
            }),
        { message: /unsafe segment/ }
    )
    t.throws(
        () =>
            validateSparkplugProjectionContract({
                ...contract,
                devices: [{ ...contract.devices[0] }, { ...contract.devices[0] }]
            }),
        { message: /duplicates/ }
    )
})

test('projection contracts validate metric metadata combinations', (t) => {
    t.throws(
        () =>
            validateSparkplugProjectionContract({
                ...contract,
                devices: [
                    {
                        ...contract.devices[0],
                        metrics: [{ name: 'Mode', path: 'state.mode', datatype: 'String', unit: 'degC' }]
                    }
                ]
            }),
        { message: /numeric datatype/ }
    )
    t.throws(
        () =>
            validateSparkplugProjectionContract({
                ...contract,
                devices: [
                    {
                        ...contract.devices[0],
                        metrics: [{ name: 'Temperature', path: 'state.temperature', datatype: 'Double', minimum: 10, maximum: 0 }]
                    }
                ]
            }),
        { message: /less than or equal/ }
    )
    t.throws(
        () =>
            validateSparkplugProjectionContract({
                ...contract,
                devices: [{ ...contract.devices[0], maxPublishHz: 0 }]
            }),
        { message: /greater than zero/ }
    )
    t.throws(
        () =>
            validateSparkplugProjectionContract({
                ...contract,
                devices: [
                    {
                        ...contract.devices[0],
                        metrics: [{ name: 'Count', path: 'state.count', datatype: 'Int32', deadband: 0.5 }]
                    }
                ]
            }),
        { message: /must be an integer/ }
    )
})
