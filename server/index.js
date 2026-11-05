import "dotenv/config";
import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";

const app = express();
const prisma = new PrismaClient();
app.use(cors());
app.use(express.json());
const port = process.env.PORT || 4000;
const dayStart = (value = new Date()) => { const d = new Date(value); d.setHours(0,0,0,0); return d; };
const dayEnd = (value = new Date()) => { const d = dayStart(value); d.setDate(d.getDate()+1); return d; };
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);

app.get("/api/health", (_req,res) => res.json({ ok:true, service:"StaySuite HMS API" }));

app.get("/api/dashboard", asyncRoute(async (_req,res) => {
  const today = dayStart();
  const tomorrow = dayEnd();
  const [total, occupied, available, reserved, outOfOrder, clean, dirty, cleaning, arrivals, departures, tasks] = await Promise.all([
    prisma.room.count(), prisma.room.count({where:{occupancyStatus:"OCCUPIED"}}),
    prisma.room.count({where:{occupancyStatus:"AVAILABLE"}}), prisma.room.count({where:{occupancyStatus:"RESERVED"}}),
    prisma.room.count({where:{occupancyStatus:"OUT_OF_ORDER"}}), prisma.room.count({where:{housekeepingStatus:"CLEAN"}}),
    prisma.room.count({where:{housekeepingStatus:"DIRTY"}}), prisma.room.count({where:{housekeepingStatus:"CLEANING"}}),
    prisma.reservation.count({where:{checkIn:{gte:today,lt:tomorrow},status:"CONFIRMED"}}),
    prisma.reservation.count({where:{checkOut:{gte:today,lt:tomorrow},status:{in:["CONFIRMED","CHECKED_IN"]}}}),
    prisma.housekeepingTask.count({where:{scheduledAt:{gte:today,lt:tomorrow},status:{not:"COMPLETED"}}})
  ]);
  res.json({rooms:{total,occupied,available,reserved,outOfOrder},housekeeping:{clean,dirty,cleaning},arrivals,departures,pendingTasks:tasks});
}));

app.get("/api/rooms", asyncRoute(async (req,res) => {
  const where = {};
  if (req.query.occupancyStatus) where.occupancyStatus = req.query.occupancyStatus;
  if (req.query.housekeepingStatus) where.housekeepingStatus = req.query.housekeepingStatus;
  if (req.query.floor) where.floor = Number(req.query.floor);
  res.json(await prisma.room.findMany({where,orderBy:[{floor:"asc"},{number:"asc"}]}));
}));
app.post("/api/rooms", asyncRoute(async (req,res) => {
  const {number,floor,category,rate} = req.body;
  if (!number || !category || rate == null) return res.status(400).json({error:"Room number, category and rate are required"});
  res.status(201).json(await prisma.room.create({data:{number:String(number),floor:Number(floor||1),category,rate}}));
}));
app.patch("/api/rooms/:id", asyncRoute(async (req,res) => {
  const allowed = ["floor","category","rate","occupancyStatus","housekeepingStatus","notes"];
  const data = Object.fromEntries(Object.entries(req.body).filter(([key])=>allowed.includes(key)));
  res.json(await prisma.room.update({where:{id:req.params.id},data}));
}));

app.get("/api/reservations", asyncRoute(async (req,res) => {
  const where = {};
  if (req.query.status) where.status = req.query.status;
  if (req.query.date) { const d=dayStart(req.query.date); where.checkIn={gte:d,lt:dayEnd(d)}; }
  res.json(await prisma.reservation.findMany({where,include:{guest:true,room:true,payments:true},orderBy:{checkIn:"asc"}}));
}));
app.post("/api/reservations", asyncRoute(async (req,res) => {
  const {guestId,roomId,checkIn,checkOut,totalAmount,adults,children,source,notes} = req.body;
  if (!guestId||!roomId||!checkIn||!checkOut||totalAmount==null) return res.status(400).json({error:"Complete all required reservation fields"});
  const start=new Date(checkIn), end=new Date(checkOut);
  if (!(end>start)) return res.status(400).json({error:"Check-out must be after check-in"});
  const conflict=await prisma.reservation.findFirst({where:{roomId,status:{in:["CONFIRMED","CHECKED_IN"]},checkIn:{lt:end},checkOut:{gt:start}}});
  if(conflict) return res.status(409).json({error:"This room already has a reservation for those dates"});
  const bookingCode="ST"+Date.now().toString().slice(-8);
  const reservation=await prisma.reservation.create({data:{bookingCode,guestId,roomId,checkIn:start,checkOut:end,totalAmount,adults:Number(adults||1),children:Number(children||0),source:source||"WALK_IN",notes,status:"CONFIRMED"},include:{guest:true,room:true}});
  await prisma.room.update({where:{id:roomId},data:{occupancyStatus:"RESERVED"}});
  res.status(201).json(reservation);
}));
app.patch("/api/reservations/:id/status", asyncRoute(async (req,res) => {
  const {status}=req.body;
  const allowed=["PENDING","CONFIRMED","CHECKED_IN","CHECKED_OUT","CANCELLED","NO_SHOW"];
  if(!allowed.includes(status)) return res.status(400).json({error:"Invalid reservation status"});
  const r=await prisma.reservation.update({where:{id:req.params.id},data:{status},include:{room:true}});
  if(status==="CHECKED_IN") await prisma.room.update({where:{id:r.roomId},data:{occupancyStatus:"OCCUPIED",housekeepingStatus:"CLEAN"}});
  if(["CHECKED_OUT","CANCELLED","NO_SHOW"].includes(status)) await prisma.room.update({where:{id:r.roomId},data:{occupancyStatus:"AVAILABLE",housekeepingStatus:status==="CHECKED_OUT"?"DIRTY":r.room.housekeepingStatus}});
  res.json(r);
}));

app.get("/api/guests", asyncRoute(async (_req,res)=>res.json(await prisma.guest.findMany({orderBy:{createdAt:"desc"}}))));
app.post("/api/guests", asyncRoute(async (req,res)=>{
  const {fullName,phone,email,idType,idNumber}=req.body;
  if(!fullName||!phone) return res.status(400).json({error:"Guest name and phone are required"});
  res.status(201).json(await prisma.guest.create({data:{fullName,phone,email,idType,idNumber}}));
}));

app.get("/api/housekeeping", asyncRoute(async (req,res)=>{
  const where={};
  if(req.query.status) where.status=req.query.status;
  if(req.query.date){const d=dayStart(req.query.date);where.scheduledAt={gte:d,lt:dayEnd(d)};}
  res.json(await prisma.housekeepingTask.findMany({where,include:{room:true},orderBy:{scheduledAt:"desc"}}));
}));
app.post("/api/housekeeping", asyncRoute(async (req,res)=>{
  const {roomId,description,assignedTo,scheduledAt,taskType}=req.body;
  if(!roomId||!description) return res.status(400).json({error:"Room and task description are required"});
  res.status(201).json(await prisma.housekeepingTask.create({data:{roomId,description,assignedTo,taskType,scheduledAt:scheduledAt?new Date(scheduledAt):new Date()}}));
}));
app.post("/api/housekeeping/generate-daily", asyncRoute(async (_req,res)=>{
  const today=dayStart(), tomorrow=dayEnd();
  const occupied=await prisma.room.findMany({where:{occupancyStatus:"OCCUPIED"}});
  let created=0;
  for(const room of occupied){
    const existing=await prisma.housekeepingTask.findFirst({where:{roomId:room.id,taskType:"DAILY_CLEANING",scheduledAt:{gte:today,lt:tomorrow}}});
    if(!existing){await prisma.housekeepingTask.create({data:{roomId:room.id,taskType:"DAILY_CLEANING",description:"Daily occupied-room cleaning"}});created++;}
  }
  res.json({created,message:`Created ${created} daily cleaning tasks`});
}));
app.patch("/api/housekeeping/:id/status", asyncRoute(async (req,res)=>{
  const {status}=req.body;
  if(!["PENDING","IN_PROGRESS","COMPLETED"].includes(status)) return res.status(400).json({error:"Invalid task status"});
  const task=await prisma.housekeepingTask.update({where:{id:req.params.id},data:{status,startedAt:status==="IN_PROGRESS"?new Date():undefined,completedAt:status==="COMPLETED"?new Date():null},include:{room:true}});
  const housekeepingStatus=status==="IN_PROGRESS"?"CLEANING":status==="COMPLETED"?"CLEAN": "DIRTY";
  await prisma.room.update({where:{id:task.roomId},data:{housekeepingStatus}});
  res.json(task);
}));

app.get("/api/payments", asyncRoute(async (_req,res)=>res.json(await prisma.payment.findMany({include:{guest:true,reservation:true},orderBy:{paidAt:"desc"}}))));
app.post("/api/payments", asyncRoute(async (req,res)=>{
  const {guestId,reservationId,amount,method,reference}=req.body;
  if(!guestId||amount==null||!["CASH","UPI","CARD","ONLINE"].includes(method)) return res.status(400).json({error:"Guest, amount and valid payment method are required"});
  res.status(201).json(await prisma.payment.create({data:{paymentCode:"PAY"+Date.now().toString().slice(-8),guestId,reservationId:reservationId||null,amount,method,reference},include:{guest:true}}));
}));

app.get("/api/room-rack", asyncRoute(async (req,res)=>{
  const mode=["daily","weekly","monthly"].includes(req.query.mode)?req.query.mode:"daily";
  const start=dayStart(req.query.date||new Date());
  const days=mode==="daily"?1:mode==="weekly"?7:30;
  const end=new Date(start);end.setDate(end.getDate()+days);
  const [rooms,reservations]=await Promise.all([
    prisma.room.findMany({orderBy:[{floor:"asc"},{number:"asc"}]}),
    prisma.reservation.findMany({where:{checkIn:{lt:end},checkOut:{gt:start},status:{in:["CONFIRMED","CHECKED_IN"]}},include:{guest:true}})
  ]);
  const dates=Array.from({length:days},(_,i)=>{const d=new Date(start);d.setDate(d.getDate()+i);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,"0"),String(d.getDate()).padStart(2,"0")].join("-");});
  res.json({mode,dates,rooms:rooms.map(room=>({...room,reservations:reservations.filter(r=>r.roomId===room.id)}))});
}));

app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:err.code==="P2002"?"That record already exists": "Server error. Check the server logs."});});
app.listen(port,()=>console.log(`StaySuite API running on http://localhost:${port}`));