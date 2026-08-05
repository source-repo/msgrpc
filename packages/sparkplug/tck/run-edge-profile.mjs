#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { connectAsync } from 'mqtt'
import { MqttSparkplugEdgeNodeSession } from '../dist/index.js'

const execFile = promisify(execFileCallback)
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reportsDirectory = join(packageDirectory, 'tck', 'reports')
const reportDate = new Date().toISOString().slice(0, 10)
const outputPrefix = resolve(process.env.SOURCE_SPARK_TCK_REPORT ?? join(reportsDirectory, `${reportDate}-edge-profile`))
const port = Number.parseInt(process.env.SOURCE_SPARK_TCK_PORT ?? '1885', 10)
const brokerUrl = `mqtt://127.0.0.1:${port}`

const TCK_VERSION = '3.0.0'
const TCK_URL = `https://download.eclipse.org/sparkplug/${TCK_VERSION}/Eclipse-Sparkplug-TCK-${TCK_VERSION}.zip`
const TCK_SHA256 = 'a70b2c2f00d67ac714eadd5ac50f6241e0efa26036d95ca8ec667d491021b86b'
const HIVEMQ_IMAGE = 'hivemq/hivemq-ce@sha256:5f440cd2e286a3810001939767e3d91bd056a5687611344e929b5198090567d5'
const cacheDirectory = resolve(
    process.env.SOURCE_SPARK_TCK_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'source-spark', 'sparkplug-tck')
)
const archive = join(cacheDirectory, basename(TCK_URL))
const containerName = `source-spark-tck-${process.pid}`
const controlTopic = 'SPARKPLUG_TCK/TEST_CONTROL'
const resultTopic = 'SPARKPLUG_TCK/RESULT'

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

function log(message) {
    process.stdout.write(`${message}\n`)
}

async function exists(path) {
    try {
        await access(path)
        return true
    } catch {
        return false
    }
}

async function sha256(path) {
    return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function downloadTck() {
    await mkdir(cacheDirectory, { recursive: true })
    if (!(await exists(archive)) || (await sha256(archive)) !== TCK_SHA256) {
        log(`Downloading Eclipse Sparkplug TCK ${TCK_VERSION}`)
        const response = await fetch(TCK_URL)
        if (!response.ok) throw new Error(`TCK download failed: ${response.status} ${response.statusText}`)
        const temporaryArchive = `${archive}.${process.pid}.tmp`
        await writeFile(temporaryArchive, new Uint8Array(await response.arrayBuffer()))
        if ((await sha256(temporaryArchive)) !== TCK_SHA256) throw new Error('downloaded TCK archive SHA-256 does not match the pinned value')
        await copyFile(temporaryArchive, archive)
        await rm(temporaryArchive, { force: true })
    }
    if ((await sha256(archive)) !== TCK_SHA256) throw new Error('cached TCK archive SHA-256 does not match the pinned value')
}

async function prepareExtension(runtimeDirectory) {
    await execFile('unzip', ['-q', archive, '-d', runtimeDirectory])
    const nestedArchive = join(runtimeDirectory, 'SparkplugTCK', 'hivemq-extension', `sparkplug-tck-${TCK_VERSION}.zip`)
    const extensionsDirectory = join(runtimeDirectory, 'extensions')
    await mkdir(extensionsDirectory)
    await execFile('unzip', ['-q', nestedArchive, '-d', extensionsDirectory])
    return join(extensionsDirectory, 'sparkplug-tck')
}

async function startBroker(extensionDirectory) {
    await execFile('docker', ['pull', HIVEMQ_IMAGE], { maxBuffer: 20 * 1024 * 1024 })
    await execFile('docker', [
        'run',
        '-d',
        '--name',
        containerName,
        '-p',
        `127.0.0.1:${port}:1883`,
        '-v',
        `${extensionDirectory}:/opt/hivemq/extensions/sparkplug-tck:ro`,
        HIVEMQ_IMAGE
    ])
    for (let attempt = 0; attempt < 120; attempt += 1) {
        const { stdout, stderr } = await execFile('docker', ['logs', containerName])
        if (`${stdout}${stderr}`.includes('Started TCP Listener')) return
        await delay(100)
    }
    throw new Error(`TCK broker did not become ready at ${brokerUrl}`)
}

function parseSummary(name, summary) {
    const count = (status) => summary.split('\n').filter((line) => !line.startsWith('OVERALL:') && line.includes(`: ${status}`)).length
    const overall = summary.match(/^OVERALL: (.+);$/m)?.[1] ?? 'MISSING'
    return {
        name,
        summary,
        overall,
        pass: count('PASS'),
        fail: count('FAIL'),
        notExecuted: count('NOT EXECUTED'),
        maybe: count('MAYBE')
    }
}

function metric(name, alias, value, datatype = 10) {
    return { name, alias, timestamp: Date.now() - 1, datatype, value }
}

async function waitFor(condition, description, timeout = 8000) {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`${description} timed out`)
        await delay(20)
    }
}

async function createEdge(ids, options = {}) {
    return MqttSparkplugEdgeNodeSession.connect({
        url: brokerUrl,
        groupId: ids.group,
        edgeNodeId: ids.edge,
        clientId: `${ids.edge}-client`,
        now: () => Date.now() - 1,
        birthMetrics: [metric('Node/Temperature', 1, 21.5)],
        ...options
    })
}

async function closeEdge(edge) {
    if (!edge) return
    if (edge.client.connected) {
        await edge.close()
    } else {
        await edge.client.endAsync(true)
    }
}

async function runScenarios(control) {
    const results = []
    let resultResolver
    let resultRejecter
    let resultTimer
    control.on('message', (topic, payload) => {
        if (topic !== resultTopic || !resultResolver) return
        clearTimeout(resultTimer)
        const resolveResult = resultResolver
        resultResolver = undefined
        resultRejecter = undefined
        resolveResult(payload.toString())
    })
    await control.subscribeAsync(resultTopic, { qos: 1 })
    await control.publishAsync('SPARKPLUG_TCK/RESULT_CONFIG', 'NEW_RESULT-LOG /opt/hivemq/data/SourceSparkTCKResults.log', { qos: 1, retain: true })
    await control.publishAsync('SPARKPLUG_TCK/CONFIG', 'UTCwindow 60000', { qos: 1, retain: true })
    await delay(250)

    const run = async (name, action, timeout = 12000) => {
        const suffix = `${process.pid}-${results.length}`
        const ids = {
            host: `source-spark-host-${suffix}`,
            group: `source-spark-group-${suffix}`,
            edge: `source-spark-edge-${suffix}`,
            device: `source-spark-device-${suffix}`
        }
        const result = new Promise((resolveResult, rejectResult) => {
            resultResolver = resolveResult
            resultRejecter = rejectResult
            resultTimer = setTimeout(() => {
                resultResolver = undefined
                resultRejecter = undefined
                rejectResult(new Error(`${name} result timed out`))
            }, timeout)
        })
        void result.catch(() => undefined)
        log(`Running Edge ${name}`)
        await control.publishAsync(controlTopic, `NEW_TEST edge ${name} ${ids.host} ${ids.group} ${ids.edge} ${ids.device}`, { qos: 1 })
        await delay(400)
        try {
            await action(ids, result)
            const parsed = parseSummary(name, await result)
            results.push(parsed)
            log(`  ${parsed.overall} (${parsed.pass} pass, ${parsed.fail} fail, ${parsed.notExecuted} not executed, ${parsed.maybe} maybe)`)
        } catch (error) {
            clearTimeout(resultTimer)
            resultResolver = undefined
            resultRejecter = undefined
            try {
                await control.publishAsync(controlTopic, 'END_TEST', { qos: 1 })
            } catch {
                // Preserve the scenario error.
            }
            throw error
        }
    }

    await run('SessionEstablishmentTest', async (ids, result) => {
        let edge
        try {
            edge = await createEdge(ids, { primaryHostId: ids.host })
            await waitFor(() => edge.session.born, 'Primary Host gated NBIRTH')
            await edge.session.deviceBirth(ids.device, [metric('Device/Temperature', 2, 21.5)])
            await result
        } finally {
            await delay(100)
            await closeEdge(edge)
        }
    })

    await run('SessionTerminationTest', async (ids) => {
        const edge = await createEdge(ids)
        await edge.session.deviceBirth(ids.device, [metric('Device/Temperature', 2, 21.5)])
        await edge.session.deviceDeath(ids.device)
        await edge.close()
    })

    await run('SendDataTest', async (ids, result) => {
        let edge
        try {
            edge = await createEdge(ids)
            await edge.session.deviceBirth(ids.device, [metric('Device/Temperature', 2, 21.5)])
            await edge.session.data([{ alias: 1, timestamp: Date.now() - 1, datatype: 10, value: 22 }])
            await edge.session.deviceData(ids.device, [{ alias: 2, timestamp: Date.now() - 1, datatype: 10, value: 22 }])
            await result
        } finally {
            await closeEdge(edge)
        }
    })

    await run('SendComplexDataTest', async (ids, result) => {
        let edge
        try {
            edge = await createEdge(ids)
            await edge.session.deviceBirth(ids.device, [
                metric('Device/Running', 2, true, 11),
                metric('Device/Count', 3, 7, 3),
                metric('Device/Name', 4, 'pump', 12),
                metric('Device/Timestamp', 5, Date.now() - 1, 13),
                metric('Device/Bytes', 6, new Uint8Array([1, 2, 3]), 17)
            ])
            await edge.session.data([{ alias: 1, timestamp: Date.now() - 1, datatype: 10, value: 22 }])
            await edge.session.deviceData(ids.device, [{ alias: 2, timestamp: Date.now() - 1, datatype: 11, value: false }])
            await delay(500)
            await control.publishAsync(controlTopic, 'END_TEST', { qos: 1 })
            await result
        } finally {
            await closeEdge(edge)
        }
    })

    await run('ReceiveCommandTest', async (ids, result) => {
        let edge
        try {
            edge = await createEdge(ids)
            await edge.session.deviceBirth(ids.device, [metric('Device/Temperature', 2, 21.5)])
            await result
        } finally {
            await closeEdge(edge)
        }
    }, 15000)

    await run('PrimaryHostTest', async (ids, result) => {
        let edge
        try {
            edge = await createEdge(ids, { primaryHostId: ids.host })
            await waitFor(() => edge.session.born, 'Primary Host online NBIRTH', 10000)
            await edge.session.deviceBirth(ids.device, [metric('Device/Temperature', 2, 21.5)])
            await result
            await delay(200)
        } finally {
            await closeEdge(edge)
        }
    }, 30000)

    if (resultRejecter) resultRejecter(new Error('TCK runner ended with an unresolved result'))
    return results
}

function markdownReport(results, rawLogName) {
    const rows = results
        .map((result) => `| ${result.name.replace(/Test$/, '')} | ${result.overall} | ${result.pass} | ${result.fail} | ${result.notExecuted} | ${result.maybe} |`)
        .join('\n')
    const failures = results.flatMap((result) =>
        result.summary
            .split('\n')
            .filter((line) => line.includes(': FAIL'))
            .map((line) => `- ${result.name}: ${line}`)
    )
    return `# Eclipse Sparkplug TCK 3.0.0 Edge profile baseline

Date: ${reportDate}

This is a reproducible development baseline for \`@source-repo/sparkplug\`. It is not an Eclipse Foundation compatibility claim or listing.

## Inputs

- Official binary: ${TCK_URL}
- Binary SHA-256: \`${TCK_SHA256}\`
- HiveMQ image: \`${HIVEMQ_IMAGE}\`
- Runner: \`npm run tck:edge -w @source-repo/sparkplug\`
- Raw official result log: [${rawLogName}](./${rawLogName})

## Results

| Scenario | Overall | PASS | FAIL | Not executed | MAYBE |
| --- | --- | ---: | ---: | ---: | ---: |
${rows}

${failures.length ? `## Failures\n\n${failures.join('\n')}\n\n` : ''}## Scope and exclusions

- The Edge profile scenarios run over MQTT 3.1.1: Session Establishment, Session Termination, Send Data, Send Complex Data, Receive Command, and Primary Host.
- The optional Multiple Broker scenario is not run because the package currently owns one MQTT connection.
- Dataset and Template payload groups are not exercised because those datatypes are outside the current M1 encoder.
- MQTT 5 alternatives and optional payload groups may therefore remain \`NOT EXECUTED\`; SHOULD-level observations may be reported as \`MAYBE\`.
- Before the fixes captured by this baseline, Session Establishment returned \`OVERALL: FAIL but INCOMPLETE\`: generated topics used \`spBv1.0/<message-type>/<group>/...\` instead of the required \`spBv1.0/<group>/<message-type>/...\`, so the TCK could not identify the Edge Node Will. The same slice added the mandatory false \`Node Control/Rebirth\` NBIRTH metric and DCMD subscription.
`
}

async function main() {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SOURCE_SPARK_TCK_PORT must be a valid TCP port')
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'source-spark-tck-'))
    let control
    try {
        await downloadTck()
        const extensionDirectory = await prepareExtension(runtimeDirectory)
        await startBroker(extensionDirectory)
        control = await connectAsync(brokerUrl, { clientId: `source-spark-tck-control-${process.pid}`, clean: true, reconnectPeriod: 0 })
        await delay(1000)
        const results = await runScenarios(control)
        await mkdir(dirname(outputPrefix), { recursive: true })
        const rawLogPath = `${outputPrefix}.log`
        await execFile('docker', ['cp', `${containerName}:/opt/hivemq/data/SourceSparkTCKResults.log`, rawLogPath])
        await writeFile(`${outputPrefix}.md`, markdownReport(results, basename(rawLogPath)))
        const failed = results.some((result) => result.fail > 0 || result.overall.startsWith('FAIL') || result.overall === 'MISSING')
        log(`Report: ${outputPrefix}.md`)
        if (failed) process.exitCode = 1
    } finally {
        if (control) await control.endAsync(true).catch(() => undefined)
        await execFile('docker', ['rm', '-f', containerName]).catch(() => undefined)
        await rm(runtimeDirectory, { recursive: true, force: true })
    }
}

await main()
