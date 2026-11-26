import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const rooms = [
  ...Array.from({length:8},(_,i)=>({number:String(101+i),floor:1,category:i%3===0?"Suite":i%2===0?"Deluxe":"Standard",rate:i%3===0?5200:i%2===0?3200:2200,occupancyStatus:i<4?"OCCUPIED":i===4?"RESERVED":"AVAILABLE",housekeepingStatus:i===0?"CLEAN":i===1?"DIRTY":i===2?"CLEANING":"CLEAN"})),
  ...Array.from({length:8},(_,i)=>({number:String(201+i),floor:2,category:i%3===0?"Suite":i%2===0?"Deluxe":"Standard",rate:i%3===0?5200:i%2===0?3200:2200,occupancyStatus:"AVAILABLE",housekeepingStatus:"CLEAN"}))
];

const permissionGroups = {
  dashboard: ["dashboard.view", "dashboard.viewOperationalSummaries"],
  rooms: ["rooms.view", "rooms.create", "rooms.update", "rooms.delete", "rooms.updateAvailability"],
  reservations: ["reservations.view", "reservations.create", "reservations.update", "reservations.confirm", "reservations.cancel", "reservations.checkIn", "reservations.checkOut"],
  guests: ["guests.view", "guests.create", "guests.update"],
  housekeeping: ["housekeeping.tasks.viewAll", "housekeeping.tasks.viewAssigned", "housekeeping.tasks.create", "housekeeping.tasks.assign", "housekeeping.tasks.start", "housekeeping.tasks.complete", "housekeeping.status.update"],
  payments: ["payments.view", "payments.record", "payments.refunds.process", "payments.refunds.approve"],
  staff: ["staff.view", "staff.create", "staff.update", "staff.deactivate"],
  roles: ["roles.view", "roles.create", "roles.update", "roles.assign"],
  reports: ["reports.view"],
  settings: ["settings.manage"]
};

const allPermissions = Object.values(permissionGroups).flat();
const roles = [
  {
    key: "ADMIN",
    name: "Admin",
    description: "Full access to all hotel operations and system administration.",
    permissions: allPermissions
  },
  {
    key: "MANAGER",
    name: "Manager",
    description: "Manage daily hotel operations, staff oversight, reports and refund approvals.",
    permissions: [
      "dashboard.view", "dashboard.viewOperationalSummaries",
      "rooms.view", "rooms.create", "rooms.update", "rooms.delete", "rooms.updateAvailability",
      "reservations.view", "reservations.create", "reservations.update", "reservations.confirm", "reservations.cancel", "reservations.checkIn", "reservations.checkOut",
      "guests.view", "guests.create", "guests.update",
      "housekeeping.tasks.viewAll", "housekeeping.tasks.create", "housekeeping.tasks.assign", "housekeeping.tasks.start", "housekeeping.tasks.complete", "housekeeping.status.update",
      "payments.view", "payments.record", "payments.refunds.approve",
      "staff.view", "reports.view"
    ]
  },
  {
    key: "RECEPTIONIST",
    name: "Receptionist",
    description: "Handle reservations, guest services, check-in, check-out and payment recording.",
    permissions: [
      "dashboard.view",
      "rooms.view",
      "reservations.view", "reservations.create", "reservations.update", "reservations.confirm", "reservations.cancel", "reservations.checkIn", "reservations.checkOut",
      "guests.view", "guests.create", "guests.update",
      "housekeeping.tasks.viewAll",
      "payments.view", "payments.record"
    ]
  },
  {
    key: "HOUSEKEEPING",
    name: "Housekeeping",
    description: "View assigned cleaning tasks and update their progress and room cleaning status.",
    permissions: [
      "dashboard.view",
      "rooms.view",
      "housekeeping.tasks.viewAssigned", "housekeeping.tasks.start", "housekeeping.tasks.complete", "housekeeping.status.update"
    ]
  }
];

try {
  for (const room of rooms) {
    await prisma.room.upsert({where:{number:room.number},update:{},create:room});
  }

  const existing = await prisma.guest.count();
  if (!existing) {
    await prisma.guest.createMany({data:[
      {fullName:"Aarav Sharma",phone:"+91 98765 43210",email:"aarav@example.com"},
      {fullName:"Meera Iyer",phone:"+91 98765 12340",email:"meera@example.com"}
    ]});
  }

  for (const role of roles) {
    const savedRole = await prisma.role.upsert({
      where: {key: role.key},
      update: {name: role.name, description: role.description, isSystem: true, permissions: role.permissions},
      create: {...role, isSystem: true}
    });
    await prisma.user.updateMany({
      where: {role: role.key, roleId: null},
      data: {roleId: savedRole.id}
    });
  }

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    await prisma.user.upsert({
      where: {email: adminEmail.toLowerCase()},
      update: {},
      create: {
        fullName: process.env.ADMIN_NAME || "System Administrator",
        email: adminEmail.toLowerCase(),
        passwordHash,
        role: "ADMIN",
        roleId: (await prisma.role.findUnique({where:{key:"ADMIN"}})).id
      }
    });
    console.log("Initial administrator account ensured.");
  } else {
    console.log("ADMIN_EMAIL/ADMIN_PASSWORD not set; skipped admin account creation.");
  }

  console.log("Seed data and default roles ready.");
} finally {
  await prisma.$disconnect();
}
