import type { Observable } from "rxjs";
import { BehaviorSubject } from "rxjs";

import type { CaptureHealth, CaptureSession } from "@azx/ribo-core";

/**
 * The shared handle through which `useRecorder` publishes the active capture
 * session and `useWorkSafety` reads its health.
 *
 * It exists because a session created inside one hook cannot reach a sibling:
 * `RiboProvider` passes the host's instance object through unchanged and
 * deliberately constructs nothing, so mutating that object notifies nobody.
 *
 * **The host constructs it**, like every other instance, rather than the provider
 * creating one silently. It is OPTIONAL: absent, there is no capture health and
 * `useWorkSafety` behaves as it does today.
 */
export interface CaptureCoordinator {
  register(session: CaptureSession): () => void;
  active(): CaptureSession | undefined;
  readonly health$: Observable<CaptureHealth | undefined>;
}

export function createCaptureCoordinator(): CaptureCoordinator {
  const health$ = new BehaviorSubject<CaptureHealth | undefined>(undefined);
  let session: CaptureSession | undefined;
  return {
    register(s: CaptureSession): () => void {
      session = s;
      const sub = s.health$.subscribe((h) => health$.next(h));
      return () => {
        sub.unsubscribe();
        session = undefined;
        health$.next(undefined);
      };
    },
    active(): CaptureSession | undefined {
      return session;
    },
    health$,
  };
}
