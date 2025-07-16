import { Logger, SeqLogLevel, SeqLoggerConfig } from 'seq-logging'
export { SeqLogLevel }

export class SeqLogger {
    protected logger: Logger

    constructor(
        public serverUrl: string = 'http://seq:5341',
        public apiKey?: string
    ) {
        const options: SeqLoggerConfig = {
            serverUrl,
            onError: (e) => {
                console.error('Failed to log to Seq!', e)
            }
        }
        if (apiKey) options.apiKey = apiKey
        this.logger = new Logger(options)
    }

    log(level: SeqLogLevel, messageTemplate: string, properties?: { [key: string]: unknown }) {
        this.logger.emit({
            timestamp: new Date(),
            level,
            messageTemplate,
            properties
        })
    }

    close() {
        // When you're done
        this.logger.close()
    }
}
