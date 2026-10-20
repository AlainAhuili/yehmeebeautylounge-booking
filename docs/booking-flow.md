# Booking flow (observed on Book in Beautiful)

How the current online booking at
https://yehmeebeautylounge.bookinbeautiful.de works, recorded on 2026-10-20
as the reference for our own booking system. Only the steps before entering
personal data were walked through; no booking was made.

Screenshots of each step: `docs/screenshots/`.

## Steps

1. **Choose a service** (`/book`)
   - Services grouped in 4 categories: Lashes / Wimpern (9), Lifting & Brows (2),
     Skin Treatments (3), Nails (7). Full list with durations and prices:
     [`content/services.json`](../content/services.json).
   - Each card shows name, description (DE / EN / FR), duration, price and an
     "Auswählen" button.
   - Header: "Wähle bis zu 20 Services", counter "0 Services ausgewählt", "Weiter".
   - Every service carries the note "Diese Leistung bitte separat buchen":
     one service per booking.

2. **Choose a day** (`/book/shops/<shop>?service_options[]=…&barbers[]=…`)
   - "Wähle einen Tag": calendar of 4 weeks, Tuesday to Monday rows.
   - Colors: green = many free times, yellow / orange = few left,
     red = fully booked, grey = closed (Sunday, Monday).
   - "Findest du den nächsten verfügbaren Termin" (jump to next free day),
     "Weitere Termine anzeigen" (next 4 weeks), "Zurück".

3. **Choose a time** (`/book/shops/<shop>/date/<YYYY-MM-DD>?…`)
   - "Wähle einen Termin", date as heading ("Dienstag, 20. Oktober 2026").
   - One column per staff member (only "Melissa").
   - Start times in a 15-minute grid from 10:00; unavailable times are greyed out.
   - "+1" and "+7" jump one day or one week ahead.

4. **Personal details** (not walked through): name, email, phone, or log in.

5. **Deposit** (not walked through): 15 € paid online (the page loads Stripe),
   deducted from the total; no deposit with a YehMee gift voucher.

6. **Confirmation**: confirmation by email.

## Rules for our system

| Rule | Value |
|---|---|
| Opening hours | Tue–Fri 10:00–19:30, Sat 10:00–18:00, Sun & Mon closed |
| Slot grid | Start times every 15 minutes |
| Last start time | Must let the service end by closing time (to confirm with the salon) |
| Services per booking | One |
| Staff | Melissa |
| Deposit | 15 €, online, deducted from the price; waived with a gift voucher |
| Free cancellation | Up to 48 hours before; later, the deposit is kept |
| Lateness | More than 10–15 minutes without notice: treatment shortened or moved |
| Booking horizon | At least 4 weeks shown, more on request |

## Not copied

The platform's own program code (Book in Beautiful / nearcut) is not copied:
it belongs to the platform and only works with its servers. Our system
re-implements this flow with its own code.
