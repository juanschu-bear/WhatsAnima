import type {
  PerceptionEvent,
  PerceptionEventMap,
  PerceptionEventType,
  PerceptionSnapshot,
} from "../types/perception";

type Subscriber<TType extends PerceptionEventType> = (
  event: PerceptionEvent<TType>,
) => void;

type AnySubscriber = (event: PerceptionEvent) => void;

export class PerceptionSessionBus {
  private subscribers = new Map<PerceptionEventType, Set<Subscriber<PerceptionEventType>>>();
  private anySubscribers = new Set<AnySubscriber>();
  private snapshot: PerceptionSnapshot = {};

  constructor(public readonly sessionId: string) {}

  publish<TType extends PerceptionEventType>(
    type: TType,
    payload: PerceptionEventMap[TType],
  ) {
    this.snapshot[type] = payload;
    const event = { type, payload } as PerceptionEvent<TType>;
    this.subscribers.get(type)?.forEach((subscriber) => subscriber(event));
    this.anySubscribers.forEach((subscriber) => subscriber(event));
  }

  subscribe<TType extends PerceptionEventType>(
    type: TType,
    subscriber: Subscriber<TType>,
  ) {
    const set =
      this.subscribers.get(type) ??
      new Set<Subscriber<PerceptionEventType>>();
    set.add(subscriber as Subscriber<PerceptionEventType>);
    this.subscribers.set(type, set);

    return () => {
      set.delete(subscriber as Subscriber<PerceptionEventType>);
      if (set.size === 0) {
        this.subscribers.delete(type);
      }
    };
  }

  subscribeAll(subscriber: AnySubscriber) {
    this.anySubscribers.add(subscriber);
    return () => {
      this.anySubscribers.delete(subscriber);
    };
  }

  getSnapshot() {
    return this.snapshot;
  }

  getLatest<TType extends PerceptionEventType>(type: TType) {
    return this.snapshot[type] as PerceptionEventMap[TType] | undefined;
  }

  reset() {
    this.snapshot = {};
  }
}

const sessionBusRegistry = new Map<string, PerceptionSessionBus>();

export function getPerceptionSessionBus(sessionId: string) {
  const existing = sessionBusRegistry.get(sessionId);
  if (existing) {
    return existing;
  }

  const next = new PerceptionSessionBus(sessionId);
  sessionBusRegistry.set(sessionId, next);
  return next;
}

export function clearPerceptionSessionBus(sessionId: string) {
  sessionBusRegistry.delete(sessionId);
}
