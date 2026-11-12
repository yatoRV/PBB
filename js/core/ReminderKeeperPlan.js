// Port of vn.lichdilam.ReminderKeeperPlan (APK 4.5).

/** The in-process timer is a supplement to OS alarms, never a wake-up guarantee. */
export class ReminderKeeperPlan {
  static HEARTBEAT_MS = 60000; static RETRY_MS = 30000;
  static delay(now, next) { return next <= 0 ? ReminderKeeperPlan.HEARTBEAT_MS : Math.max(250, Math.min(ReminderKeeperPlan.HEARTBEAT_MS, next - now)); }
  static due(at, now) { return at > 0 && at <= now; }
  static interruption(previousElapsed, elapsed, previousUptime, uptime) {
    return previousElapsed <= 0 ? 0 : Math.max(0, (elapsed - previousElapsed) - (uptime - previousUptime));
  }
}
