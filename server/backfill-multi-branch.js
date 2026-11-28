import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const organizationName = String(process.env.EZYSTAY_ORGANIZATION_NAME || "EzyStay").trim();
const branchName = String(process.env.EZYSTAY_INITIAL_BRANCH_NAME || "Main Branch").trim();
const branchCode = String(process.env.EZYSTAY_INITIAL_BRANCH_CODE || "MAIN").trim().toUpperCase();

if (!organizationName || !branchName || !branchCode) {
  throw new Error("Organization name, initial branch name and branch code must not be empty.");
}

try {
  await prisma.$transaction(async (tx) => {
    let organization = await tx.organization.findFirst({ where: { name: organizationName } });
    if (!organization) {
      organization = await tx.organization.create({ data: { name: organizationName } });
    }

    let branch = await tx.branch.findUnique({
      where: { organizationId_code: { organizationId: organization.id, code: branchCode } }
    });
    if (branch && branch.name !== branchName) {
      throw new Error(`Branch code "${branchCode}" already exists as "${branch.name}". Refusing to rename it automatically.`);
    }
    if (!branch) {
      branch = await tx.branch.create({
        data: { organizationId: organization.id, name: branchName, code: branchCode }
      });
    }

    // Existing operational records belong to the initial branch.
    await tx.room.updateMany({ where: { branchId: null }, data: { branchId: branch.id } });
    await tx.reservation.updateMany({ where: { branchId: null }, data: { branchId: branch.id } });
    await tx.payment.updateMany({ where: { branchId: null }, data: { branchId: branch.id } });

    // Guest records are shared across branches within the organization.
    await tx.guestAccount.updateMany({
      where: { organizationId: null },
      data: { organizationId: organization.id }
    });
    await tx.guest.updateMany({
      where: { organizationId: null },
      data: { organizationId: organization.id }
    });
    await tx.user.updateMany({
      where: { organizationId: null },
      data: { organizationId: organization.id }
    });

    // Admins remain organization-wide. Existing non-admin users start in Main Branch.
    const branchUsers = await tx.user.findMany({
      where: { organizationId: organization.id, role: { not: "ADMIN" }, branchAssignments: { none: {} } },
      select: { id: true }
    });
    if (branchUsers.length) {
      await tx.staffBranch.createMany({
        data: branchUsers.map((user) => ({ userId: user.id, branchId: branch.id })),
        skipDuplicates: true
      });
    }

    const [
      roomsWithoutBranch,
      reservationsWithoutBranch,
      paymentsWithoutBranch,
      guestsWithoutOrganization,
      accountsWithoutOrganization,
      usersWithoutOrganization,
      nonAdminUsersWithoutBranch
    ] = await Promise.all([
      tx.room.count({ where: { branchId: null } }),
      tx.reservation.count({ where: { branchId: null } }),
      tx.payment.count({ where: { branchId: null } }),
      tx.guest.count({ where: { organizationId: null } }),
      tx.guestAccount.count({ where: { organizationId: null } }),
      tx.user.count({ where: { organizationId: null } }),
      tx.user.count({ where: { organizationId: organization.id, role: { not: "ADMIN" }, branchAssignments: { none: {} } } })
    ]);

    const reservationRoomMismatch = await tx.$queryRawUnsafe(
      'SELECT COUNT(*)::int AS count FROM "Reservation" r JOIN "Room" rm ON rm."id" = r."roomId" WHERE r."branchId" IS DISTINCT FROM rm."branchId"'
    );
    const paymentReservationMismatch = await tx.$queryRawUnsafe(
      'SELECT COUNT(*)::int AS count FROM "Payment" p JOIN "Reservation" r ON r."id" = p."reservationId" WHERE p."branchId" IS DISTINCT FROM r."branchId"'
    );

    const incomplete = {
      roomsWithoutBranch,
      reservationsWithoutBranch,
      paymentsWithoutBranch,
      guestsWithoutOrganization,
      accountsWithoutOrganization,
      usersWithoutOrganization,
      nonAdminUsersWithoutBranch,
      reservationRoomMismatch: Number(reservationRoomMismatch[0]?.count || 0),
      paymentReservationMismatch: Number(paymentReservationMismatch[0]?.count || 0)
    };
    const failures = Object.entries(incomplete).filter(([, count]) => count > 0);
    if (failures.length) {
      throw new Error("Backfill verification failed: " + failures.map(([key, count]) => key + "=" + count).join(", "));
    }

    console.log(`Organization "${organization.name}" and branch "${branch.name}" are ready.`);
    console.log(`Assigned ${await tx.room.count({ where: { branchId: branch.id }})} rooms and ${await tx.reservation.count({ where: { branchId: branch.id }})} reservations to the initial branch.`);
    console.log(`Shared guest records: ${await tx.guest.count({ where: { organizationId: organization.id }})} guests and ${await tx.guestAccount.count({ where: { organizationId: organization.id }})} guest accounts.`);
    console.log(`Assigned ${branchUsers.length} existing non-admin staff accounts to the initial branch. Admin accounts retain organization-wide access.`);
    console.log("Backfill verification passed. No records were deleted.");
  });
} catch (error) {
  console.error("Multi-branch data backfill failed:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
