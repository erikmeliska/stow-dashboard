// Bounded concurrency: at most `max` run() callbacks in flight, FIFO queue.
export class Semaphore {
    constructor(max) {
        this.max = max
        this.active = 0
        this.queue = []
    }

    async run(fn) {
        if (this.active >= this.max) {
            await new Promise(resolve => this.queue.push(resolve))
        }
        this.active++
        try {
            return await fn()
        } finally {
            this.active--
            const next = this.queue.shift()
            if (next) next()
        }
    }
}
