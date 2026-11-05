import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
const prisma=new PrismaClient();
const rooms=[
  ...Array.from({length:8},(_,i)=>({number:String(101+i),floor:1,category:i%3===0?"Suite":i%2===0?"Deluxe":"Standard",rate:i%3===0?5200:i%2===0?3200:2200,occupancyStatus:i<4?"OCCUPIED":i===4?"RESERVED":"AVAILABLE",housekeepingStatus:i===0?"CLEAN":i===1?"DIRTY":i===2?"CLEANING":"CLEAN"})),
  ...Array.from({length:8},(_,i)=>({number:String(201+i),floor:2,category:i%3===0?"Suite":i%2===0?"Deluxe":"Standard",rate:i%3===0?5200:i%2===0?3200:2200,occupancyStatus:"AVAILABLE",housekeepingStatus:"CLEAN"}))
];
for(const room of rooms) await prisma.room.upsert({where:{number:room.number},update:{},create:room});
const existing=await prisma.guest.count();
if(!existing) await prisma.guest.createMany({data:[
  {fullName:"Aarav Sharma",phone:"+91 98765 43210",email:"aarav@example.com"},
  {fullName:"Meera Iyer",phone:"+91 98765 12340",email:"meera@example.com"}
]});
const adminEmail=process.env.ADMIN_EMAIL;
const adminPassword=process.env.ADMIN_PASSWORD;
if(adminEmail && adminPassword){const passwordHash=await bcrypt.hash(adminPassword,12);await prisma.user.upsert({where:{email:adminEmail.toLowerCase()},update:{},create:{fullName:process.env.ADMIN_NAME||"System Administrator",email:adminEmail.toLowerCase(),passwordHash,role:"ADMIN"}});console.log("Initial administrator account ensured.");}else console.log("ADMIN_EMAIL/ADMIN_PASSWORD not set; skipped admin account creation.");
console.log("Seed data ready.");
await prisma.$disconnect();