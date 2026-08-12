/**
 * @file Cross-tab exclusion on the Web Locks API — for capture, and for relay items.
 *
 * Baseline Widely Available since 2024-09-14, comfortably inside this project's
 * browser floor.
 *
 * **This is exclusion only, and that is the whole of its job.** Revision 8 needed
 * the lock to also imply write authorisation, which it cannot do — a lock can be
 * released while its holder's context survives (bfcache). With recovery writing a
 * new row, being wrong about liveness costs an orphan, not corruption. The bfcache
 * question stops mattering.
 */
export const CAPTURE_LOCK = "ribo-capture";

/**
 * The lock a relay holds while working one outbox item.
 *
 * Per item, not one global relay lock: two tabs draining *different* items concurrently is fine and
 * desirable, and a single lock would serialise the whole queue behind whichever tab happened to start.
 *
 * **Web Locks rather than a lease field, and the reason is crash resume.** `ACTIVE_OUTBOX_STATUSES`
 * deliberately includes the in-flight statuses (`transcribing`, `extracting`, `writing`) so that a step
 * interrupted by a dead tab is picked up again rather than stranded. A lease would have to express
 * that with an expiry — which means a tuned timeout, and a wrong guess either strands work or lets two
 * tabs run the same step. A Web Lock is released by the browser when its holding context dies, so
 * "the tab that owned this is gone" and "the lock is free" are the same event, with no clock involved.
 */
export function relayItemLock(id: string): string {
  return `ribo-relay-item:${id}`;
}

export interface HeldLock<T> {
  /** Resolves when `run` finishes — NOT when the lock is released. */
  readonly ready: Promise<T>;
  /**
   * Resolves once the browser has actually released the lock. Chromium's Web
   * Locks implementation completes the release one async step after the
   * callback's promise settles, so `ready` resolving does not mean `isLockFree`
   * would answer `true` yet. Await THIS before checking.
   */
  readonly released: Promise<void>;
}

/**
 * Take `name` if it is free and run `run` while holding it.
 *
 * Returns `undefined` immediately when the lock is held, rather than queueing:
 * a second tab must be told "capture is busy" now, not eventually.
 *
 * **Two promises, deliberately.** `navigator.locks.request()` does not resolve
 * until its callback ends, so awaiting it would mean `start()` blocked for the
 * entire recording. This resolves as soon as `run` has been entered, while the
 * lock stays held until `run` settles.
 */
export async function holdLock<T>(
  name: string,
  run: () => Promise<T>,
  locks: LockManager = navigator.locks,
): Promise<HeldLock<T> | undefined> {
  let entered!: (held: HeldLock<T>) => void;
  const acquired = new Promise<HeldLock<T> | undefined>((resolve) => {
    entered = resolve as (held: HeldLock<T>) => void;
  });

  let markReleased!: () => void;
  const released = new Promise<void>((r) => (markReleased = r));

  void locks
    .request(name, { ifAvailable: true }, (lock) => {
      if (lock === null) {
        entered(undefined as never);
        markReleased();
        return Promise.resolve();
      }
      const ready = run();
      entered({ ready, released });
      return ready;
    })
    .then(
      () => markReleased(),
      () => {
        markReleased();
        entered(undefined as never);
      },
    );

  return acquired;
}

/** Whether `name` could be taken right now. Used by recovery to tell an abandoned
 * recording from a live one. */
export async function isLockFree(
  name: string,
  locks: LockManager = navigator.locks,
): Promise<boolean> {
  return (await locks.request(name, { ifAvailable: true }, (lock) => lock !== null)) as boolean;
}
