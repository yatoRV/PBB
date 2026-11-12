// Port of vn.lichdilam.ReminderQueue (APK 4.5). LinkedHashMap<Long,…> → Map (insertion order).
import { UUID, utf8Encode, compareTo } from '../platform/java.js';
import { ReminderPlanner } from './ReminderPlanner.js';

const LIMIT = 64;

class Slot {
  constructor(at, values) {
    this.at = at; this.events = [...values];
    const keys = []; for (const e of values) keys.push(e.key());
    keys.sort(compareTo);
    this.id = 'q40-' + UUID.nameUUIDFromBytes(utf8Encode(keys.join('\n')));
  }
}

/** Bounded, independently addressable future batches. Removing one never changes another's identity. */
export class ReminderQueue {
  static LIMIT = LIMIT;
  static Slot = Slot;
  static plan(input) {
    const sorted = [...input];
    sorted.sort(ReminderPlanner._byTimeThenKey);
    const batches = new Map(); const seen = new Set();
    for (const e of sorted) {
      const at = e.at.toEpochMilli();
      if (seen.has(e.key())) continue; seen.add(e.key());
      if (!batches.has(at) && batches.size >= LIMIT) break;
      if (!batches.has(at)) batches.set(at, []); batches.get(at).push(e);
    }
    const out = []; for (const [at, events] of batches) out.push(new Slot(at, events)); return out;
  }
}
