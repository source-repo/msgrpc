export type LogLevel = 'Verbose' | 'Debug' | 'Information' | 'Warning' | 'Error' | 'Fatal'

export interface ILogger {
    log: (level: LogLevel, messageTemplate: string, properties?: { [key: string]: unknown }) => void
}
