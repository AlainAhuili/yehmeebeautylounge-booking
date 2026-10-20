// Free appointment times. Pure functions: no files, no clock (the caller passes `now`).
// Dates are "YYYY-MM-DD" and times are minutes after midnight, both in the salon's time zone.

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function toHHMM(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function weekdayOf(date) {
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
}

export function addDays(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The salon's local date and minute-of-day for an instant. */
export function localNow(instant, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(instant).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** [open, close] in minutes, or null when closed. */
export function openingFor(date, salon) {
  const hours = salon.openingHours[weekdayOf(date)];
  return hours ? [toMinutes(hours[0]), toMinutes(hours[1])] : null;
}

/**
 * Every start time of the day's grid, with whether it can be booked.
 * A start is free when the whole treatment fits before closing, it is far enough
 * in the future, it is inside the booking horizon, and it overlaps no booking.
 * @param {{ date: string, durationMin: number, salon: object, bookings: {start:number,end:number}[], now: {date:string, minutes:number} }} input
 */
export function timesForDay({ date, durationMin, salon, bookings, now }) {
  const hours = openingFor(date, salon);
  if (!hours) return [];
  const [open, close] = hours;
  const { slotMinutes, leadMinutes, horizonDays } = salon.booking;
  const lastDay = addDays(now.date, horizonDays);
  const earliest = date === now.date ? now.minutes + leadMinutes : -Infinity;
  const bookable = date >= now.date && date <= lastDay;

  const times = [];
  for (let start = open; start < close; start += slotMinutes) {
    const end = start + durationMin;
    const free = bookable
      && end <= close
      && start >= earliest
      && !bookings.some((b) => start < b.end && b.start < end);
    times.push({ time: toHHMM(start), free });
  }
  return times;
}

/** Calendar color for a day: closed, past, full, few, some or free. */
export function dayStatus(times, date, now) {
  if (!times.length) return 'closed';
  if (date < now.date) return 'past';
  const free = times.filter((t) => t.free).length;
  if (free === 0) return 'full';
  if (free <= 2) return 'few';
  if (free <= 5) return 'some';
  return 'free';
}
