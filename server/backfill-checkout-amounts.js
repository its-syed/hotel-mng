import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const TIME_ZONE = "Asia/Kolkata";

function localDateKey(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function calendarDaysBetween(start, end) {
  const startUtc = Date.parse(`${start}T00:00:00.000Z`);
  const endUtc = Date.parse(`${end}T00:00:00.000Z`);
  return Math.round((endUtc - startUtc) / 86400000);
}

async function main() {
  const candidates = await prisma.reservation.findMany({
    where: {
      status: "CHECKED_OUT",
      totalAmount: null
    },
    include: {
      room: {
        select: { number: true, rate: true }
      }
    },
    orderBy: { checkedOutAt: "asc" }
  });

  let updated = 0;
  let skippedNoActualCheckout = 0;
  let skippedInvalidStay = 0;
  let skippedInvalidRate = 0;

  for (const reservation of candidates) {
    // Do not guess an actual checkout date from a planned date.
    if (!reservation.checkedOutAt) {
      skippedNoActualCheckout++;
      continue;
    }

    const checkInDate = localDateKey(reservation.checkIn);
    const actualCheckoutDate = localDateKey(reservation.checkedOutAt);
    const nights = calendarDaysBetween(checkInDate, actualCheckoutDate);
    if (!Number.isInteger(nights) || nights < 1) {
      skippedInvalidStay++;
      continue;
    }

    // The current room rate is the only rate available for older bookings.
    // This is an estimate if the room rate changed after the stay.
    const nightlyRate = Number(reservation.room?.rate);
    if (!Number.isFinite(nightlyRate) || nightlyRate <= 0) {
      skippedInvalidRate++;
      continue;
    }

    const estimatedAmount = Number((nightlyRate * nights).toFixed(2));
    const result = await prisma.reservation.updateMany({
      where: {
        id: reservation.id,
        status: "CHECKED_OUT",
        totalAmount: null
      },
      data: { totalAmount: estimatedAmount }
    });

    updated += result.count;
  }

  console.log("EzyStay historical checkout amount backfill complete.");
  console.log(`Checked-out reservations with blank amounts: ${candidates.length}`);
  console.log(`Amounts filled with estimated room rate × nights: ${updated}`);
  console.log(`Skipped (no actual checkout timestamp): ${skippedNoActualCheckout}`);
  console.log(`Skipped (same-day or invalid stay dates): ${skippedInvalidStay}`);
  console.log(`Skipped (missing/invalid room rate): ${skippedInvalidRate}`);
  console.log("Existing amounts and all reservation/payment statuses were left unchanged.");
}

main()
  .catch((error) => {
    console.error("Historical checkout amount backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
