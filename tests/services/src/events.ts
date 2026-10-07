export interface EventKey {
  readonly signature: string;
  readonly instructionIndex: number;
  readonly eventIndex: number;
  readonly program: string;
  readonly name: string;
}

export const eventId = (event: EventKey): string =>
  [event.signature, event.instructionIndex, event.eventIndex, event.program, event.name.toLowerCase()].join(':');

export interface EventDiff {
  readonly missing: readonly EventKey[];
  readonly unexpected: readonly EventKey[];
}

export function diffEvents(expected: readonly EventKey[], stored: readonly EventKey[]): EventDiff {
  const storedIds = new Set(stored.map(eventId));
  const expectedIds = new Set(expected.map(eventId));
  return {
    missing: expected.filter((event) => !storedIds.has(eventId(event))),
    unexpected: stored.filter((event) => !expectedIds.has(eventId(event))),
  };
}

export function eventNames(events: readonly EventKey[]): string[] {
  return [...new Set(events.map((event) => event.name.toLowerCase()))].sort();
}
