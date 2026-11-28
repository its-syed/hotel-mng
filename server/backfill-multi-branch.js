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

    const branch = await tx.branch.upsert({
      where: { organizationId_code: { organizationId: organization.id, code: branchCode } },
      update: { name: branchName },
      create: { organizationId: organization.id, name: branchName, code: branchCode }
    });

    // Existing operational records belong to the first branch.
    await tx.room.updateMany({ where: { branchId: null }, data: { branchId: branch.id } });
    await tx.reservation.updateMany({ where: { branchId: null }, data: { branchId: branch.id } });
    await tx.payment.updateMany({ where: { branchId: null }, data: { branchId: branch.id } });

    // Guest profiles and guest accounts belong to the organization, not a branch.
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

    // Admins remain organization-wide. Other existing users start in the first branch.
    const branchUsers = await tx.user.findMany({
      where: { organizationId: organization.id, role: { not: "ADMIN" } },
      select: { id: true }
    });
    if (branchUsers.length) {
      await tx.staffBranch.createMany({
        data: branchUsers.map((user) => ({ userId: user.id, branchId: branch.id })),
        skipDuplicates: true
      });
    }

    console.log(`Organization "${organization.name}" and branch "${branch.name}" are ready.`);
    console.log(`Assigned existing rooms, reservations, payments, guests and staff to the initial organization/branch.`);
  });
} catch (error) {
  console.error("Multi-branch data backfill failed:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
