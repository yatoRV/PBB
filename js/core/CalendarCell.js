// Port of vn.lichdilam.CalendarCell (APK 4.5).
import { Schedule } from './Schedule.js';

/** The same ordered text lines are used in the app calendar and home-screen widget. */
export class CalendarCell {
  static lines(schedule, index) {
    const result = []; if (!schedule.present[index]) return result; result.push(Schedule.displayCode(schedule.shifts[index]));
    if (schedule.kind !== Schedule.WORK) { const assignment = schedule.pipeLabel(index); if (assignment !== '') result.push(assignment); }
    const person = Schedule.givenName(schedule.swapPeople[index]); if (person !== '') result.push(person);
    return result;
  }
}
