export class Mutex {
	constructor() {
		this._locked = false;
		this._queue = [];
	}

	// Acquire the lock. Resolves to a release() function.
	acquire() {
		return new Promise(resolve => {
			const tryAcquire = () => {
				if (!this._locked) {
					this._locked = true;
					// release function hands the lock to the next waiter or unlocks
					const release = () => {
						const next = this._queue.shift();
						if (next) {
							// hand over the lock to the next waiter
							next();
						} else {
							this._locked = false;
						}
					};
					resolve(release);
				} else {
					// wait in queue
					this._queue.push(tryAcquire);
				}
			};
			tryAcquire();
		});
	}

	// Convenience wrapper to run a function under the lock
	async runExclusive(fn) {
		const release = await this.acquire();
		try {
			return await fn();
		} finally {
			release();
		}
	}
}
