import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addDays, dayStatus, localNow, timesForDay, weekdayOf } from '../src/availability.js';

const salon = JSON.parse(readFileSync(new URL('../content/salon.json', import.meta.url), 'utf8'));
const MONDAY = '2026-10-19';
const WEDNESDAY = '2026-10-21';
const SATURDAY = '2026-10-24';
const lastMonday = { date: '2026-10-12', minutes: 9 * 60 };
const free = (times) => times.filter((t) => t.free).map((t) => t.time);

test('weekdays and day arithmetic', () => {
  assert.equal(weekdayOf(MONDAY), 'mon');
  assert.equal(weekdayOf(WEDNESDAY), 'wed');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
});

test('the salon is closed on Sunday and Monday', () => {
  const times = timesForDay({ date: MONDAY, durationMin: 60, salon, bookings: [], now: lastMonday });
  assert.deepEqual(times, []);
  assert.equal(dayStatus(times, MONDAY, lastMonday), 'closed');
});

test('a 2:30 treatment on a weekday can start from 10:00 until 17:00, every 15 minutes', () => {
  const times = timesForDay({ date: WEDNESDAY, durationMin: 150, salon, bookings: [], now: lastMonday });
  assert.equal(times[0].time, '10:00');
  assert.equal(times.at(-1).time, '19:15');
  const starts = free(times);
  assert.equal(starts[0], '10:00');
  assert.equal(starts.at(-1), '17:00');
  assert.equal(starts.length, 29);
});

test('on Saturday the treatment must end by 18:00', () => {
  const starts = free(timesForDay({ date: SATURDAY, durationMin: 150, salon, bookings: [], now: lastMonday }));
  assert.equal(starts.at(-1), '15:30');
});

test('an existing booking blocks every start that would overlap it', () => {
  const bookings = [{ start: 12 * 60, end: 13 * 60 }];
  const starts = free(timesForDay({ date: WEDNESDAY, durationMin: 60, salon, bookings, now: lastMonday }));
  assert.ok(starts.includes('11:00'), 'ending exactly when the booking starts is fine');
  assert.ok(!starts.includes('11:15'));
  assert.ok(!starts.includes('12:45'));
  assert.ok(starts.includes('13:00'), 'starting exactly when the booking ends is fine');
});

test('today, a booking needs two hours of notice', () => {
  const now = { date: WEDNESDAY, minutes: 11 * 60 + 5 };
  const starts = free(timesForDay({ date: WEDNESDAY, durationMin: 60, salon, bookings: [], now }));
  assert.equal(starts[0], '13:15');
});

test('past days and days beyond the booking horizon cannot be booked', () => {
  const now = { date: WEDNESDAY, minutes: 9 * 60 };
  assert.deepEqual(free(timesForDay({ date: addDays(WEDNESDAY, -7), durationMin: 60, salon, bookings: [], now })), []);
  assert.deepEqual(free(timesForDay({ date: addDays(WEDNESDAY, 63), durationMin: 60, salon, bookings: [], now })), []);
  assert.ok(free(timesForDay({ date: addDays(WEDNESDAY, 56), durationMin: 60, salon, bookings: [], now })).length > 0);
});

test('the calendar color follows the number of free start times', () => {
  const day = (n) => Array.from({ length: 10 }, (_, i) => ({ time: `x${i}`, free: i < n }));
  assert.equal(dayStatus(day(0), WEDNESDAY, lastMonday), 'full');
  assert.equal(dayStatus(day(2), WEDNESDAY, lastMonday), 'few');
  assert.equal(dayStatus(day(5), WEDNESDAY, lastMonday), 'some');
  assert.equal(dayStatus(day(6), WEDNESDAY, lastMonday), 'free');
});

test('local time is read in the salon time zone, including summer time', () => {
  assert.deepEqual(localNow(new Date('2026-10-21T08:30:00Z'), 'Europe/Berlin'), { date: WEDNESDAY, minutes: 10 * 60 + 30 });
  assert.deepEqual(localNow(new Date('2026-12-31T23:30:00Z'), 'Europe/Berlin'), { date: '2027-01-01', minutes: 30 });
});
