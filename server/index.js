import "dotenv/config";
import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const app = express();
const prisma = new PrismaClient();
app.use(cors());
app.use(express.json());
const port = process.env.PORT || 4000;
const dayStart = (value = new Date()) => { const d = new Date(value); d.setHours(0,0,0,0); return d; };
const dayEnd = (value = new Date()) => { const d = dayStart(value); d.setDate(d.getDate()+1); return d; };
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);

app.get("/api/health", (_req,res) => res.json({ ok:true, service:"StaySuite HMS API" }));

const JWT_SECRET=process.env.JWT_SECRET;
if(!JWT_SECRET) console.warn("JWT_SECRET is not configured. Set it before use.");
const tokenFor=user=>jwt.sign({sub:user.id,role:user.role,email:user.email},JWT_SECRET||"development-only-change-me",{expiresIn:"12h"});
const authenticate=asyncRoute(async(req,res,next)=>{
 if(process.env.DEV_AUTH_BYPASS==="true"){req.user={id:"dev-admin",fullName:"Development Admin",email:"dev@ezystay.local",role:"ADMIN",active:true};return next();}
 const token=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
 if(!token)return res.status(401).json({error:"Please sign in"});
 try{const payload=jwt.verify(token,JWT_SECRET||"development-only-change-me");const user=await prisma.user.findUnique({where:{id:payload.sub}});if(!user||!user.active)return res.status(401).json({error:"Account is inactive"});req.user=user;next();}
 catch{return res.status(401).json({error:"Session expired. Please sign in again"});}
});
const allow=(...roles)=>(req,res,next)=>roles.includes(req.user?.role)?next():res.status(403).json({error:"Your role does not have permission for this action"});
app.post("/api/auth/login",asyncRoute(async(req,res)=>{
 const {email,password}=req.body;if(!email||!password)return res.status(400).json({error:"Email and password are required"});
 const user=await prisma.user.findUnique({where:{email:String(email).toLowerCase()}});
 if(!user||!user.active||!(await bcrypt.compare(password,user.passwordHash)))return res.status(401).json({error:"Invalid email or password"});
 res.json({token:tokenFor(user),user:{id:user.id,fullName:user.fullName,email:user.email,role:user.role}});
}));
app.get("/api/auth/me",authenticate,(req,res)=>res.json({id:req.user.id,fullName:req.user.fullName,email:req.user.email,role:req.user.role}));
app.get("/api/public/availability",asyncRoute(async(req,res)=>{
 const {checkIn,checkOut}=req.query;const start=new Date(checkIn),end=new Date(checkOut);
 if(!checkIn||!checkOut||!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<=start)return res.status(400).json({error:"Choose valid check-in and check-out dates"});
 const rooms=await prisma.room.findMany({where:{occupancyStatus:{not:"OUT_OF_ORDER"}},orderBy:[{floor:"asc"},{number:"asc"}]});
 const conflicts=await prisma.reservation.findMany({where:{status:{in:["CONFIRMED","CHECKED_IN"]},checkIn:{lt:end},OR:[{checkOut:{gt:start}},{checkOut:null}]},select:{roomId:true}});
 const busy=new Set(conflicts.map(x=>x.roomId));
 const occupiedIds=rooms.filter(r=>r.occupancyStatus==="OCCUPIED").map(r=>r.id);
 const activeStayRows=occupiedIds.length?await prisma.reservation.findMany({where:{roomId:{in:occupiedIds},status:"CHECKED_IN"},select:{roomId:true}}):[];
 const activeStayRooms=new Set(activeStayRows.map(x=>x.roomId));
 res.json(rooms.filter(r=>!busy.has(r.id)&&(r.occupancyStatus!=="OCCUPIED"||activeStayRooms.has(r.id))).map(r=>({id:r.id,number:r.number,category:r.category,rate:r.rate})));
}));
app.post("/api/public/bookings",asyncRoute(async(req,res)=>{
 const {fullName,phone,email,roomId,checkIn,checkOut,adults,children}=req.body;const start=new Date(checkIn),end=new Date(checkOut);
 if(!fullName||!phone||!roomId||!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<=start)return res.status(400).json({error:"Complete guest details and valid stay dates are required"});
 const room=await prisma.room.findUnique({where:{id:roomId}});
 if(!room||room.occupancyStatus==="OUT_OF_ORDER")return res.status(404).json({error:"Room is not available"});
 if(room.occupancyStatus==="OCCUPIED"){
  const activeStay=await prisma.reservation.findFirst({where:{roomId,status:"CHECKED_IN"}});
  if(!activeStay?.checkOut||activeStay.checkOut>start)return res.status(409).json({error:"This room is currently occupied through the selected check-in date"});
 }
 const conflict=await prisma.reservation.findFirst({where:{roomId,status:{in:["CONFIRMED","CHECKED_IN"]},checkIn:{lt:end},OR:[{checkOut:{gt:start}},{checkOut:null}]}});
 if(conflict)return res.status(409).json({error:"This room was just booked. Please search again."});
 const nights=Math.max(1,Math.ceil((end-start)/86400000));
 const result=await prisma.$transaction(async tx=>{const guest=await tx.guest.create({data:{fullName,phone,email:email||null}});const reservation=await tx.reservation.create({data:{bookingCode:"WEB"+Date.now().toString().slice(-8),guestId:guest.id,roomId,checkIn:start,checkOut:end,adults:Number(adults||1),children:Number(children||0),totalAmount:Number(room.rate)*nights,status:"PENDING",source:"WEBSITE",notes:"Public website booking request"},include:{room:true,guest:true}});await tx.reservationStatusHistory.create({data:{reservationId:reservation.id,fromStatus:null,toStatus:"PENDING",changedBy:"Customer website"}});return reservation;});
 res.status(201).json({bookingCode:result.bookingCode,status:result.status,guest:result.guest.fullName,room:result.room.number,totalAmount:result.totalAmount,message:"Your booking request has been received. The hotel will confirm it shortly."});
}));
app.post("/api/public/booking-status",asyncRoute(async(req,res)=>{
 const code=String(req.body.bookingCode||"").trim().toUpperCase();
 const phone=String(req.body.phone||"").replace(/\D/g,"");
 if(!code||!phone)return res.status(400).json({error:"Enter your booking reference and phone number"});
 const booking=await prisma.reservation.findUnique({where:{bookingCode:code},include:{guest:true,room:true}});
 const savedPhone=String(booking?.guest?.phone||"").replace(/\D/g,"");
 const phoneMatches=savedPhone===phone||(savedPhone.length>=10&&phone.length>=10&&savedPhone.slice(-10)===phone.slice(-10));
 if(!booking||!phoneMatches)return res.status(404).json({error:"We couldn't find a booking with those details. Check your reference and phone number."});
 res.json({bookingCode:booking.bookingCode,status:booking.status,guest:booking.guest.fullName,room:booking.room.number,category:booking.room.category,checkIn:booking.checkIn,checkOut:booking.checkOut,totalAmount:booking.totalAmount,adults:booking.adults,children:booking.children,createdAt:booking.createdAt});
}));
app.use("/api",(req,res,next)=>{if(req.path.startsWith("/auth/")||req.path.startsWith("/public/"))return next();authenticate(req,res,next);});


app.get("/api/dashboard", allow("ADMIN","MANAGER","RECEPTIONIST","HOUSEKEEPING"), asyncRoute(async (_req,res) => {
  const today = dayStart();
  const tomorrow = dayEnd();
  const [total, occupied, availableBase, outOfOrder, clean, dirty, cleaning, arrivals, departures, checkIns, checkOuts, tasks, reservedTodayRows] = await Promise.all([
    prisma.room.count(), prisma.room.count({where:{occupancyStatus:"OCCUPIED"}}),
    prisma.room.count({where:{occupancyStatus:{in:["AVAILABLE","RESERVED"]}}}), prisma.room.count({where:{occupancyStatus:"OUT_OF_ORDER"}}),
    prisma.room.count({where:{housekeepingStatus:"CLEAN"}}),
    prisma.room.count({where:{housekeepingStatus:"DIRTY"}}), prisma.room.count({where:{housekeepingStatus:"CLEANING"}}),
    prisma.reservation.count({where:{checkIn:{gte:today,lt:tomorrow},status:"CONFIRMED"}}),
    prisma.reservation.count({where:{checkOut:{gte:today,lt:tomorrow},status:{in:["CONFIRMED","CHECKED_IN"]}}}),
    prisma.reservation.count({where:{checkedInAt:{gte:today,lt:tomorrow}}}),
    prisma.reservation.count({where:{checkedOutAt:{gte:today,lt:tomorrow}}}),
    prisma.housekeepingTask.count({where:{scheduledAt:{gte:today,lt:tomorrow},status:{not:"COMPLETED"}}}),
    prisma.reservation.findMany({where:{status:"CONFIRMED",checkIn:{lt:tomorrow},OR:[{checkOut:{gt:today}},{checkOut:null}]},select:{roomId:true},distinct:["roomId"]})
  ]);
  const reserved=await prisma.room.count({where:{id:{in:reservedTodayRows.map(r=>r.roomId)},occupancyStatus:{in:["AVAILABLE","RESERVED"]}}});
  const available=Math.max(0,availableBase-reserved);
  res.json({rooms:{total,occupied,available,reserved,outOfOrder},housekeeping:{clean,dirty,cleaning},arrivals,departures,checkIns,checkOuts,pendingTasks:tasks});
}));

app.get("/api/rooms", allow("ADMIN","MANAGER","RECEPTIONIST","HOUSEKEEPING"), asyncRoute(async (req,res) => {
  const where = {};
  if (req.query.housekeepingStatus) where.housekeepingStatus = req.query.housekeepingStatus;
  if (req.query.floor) where.floor = Number(req.query.floor);
  const today=dayStart(), tomorrow=dayEnd();
  const [allRooms,reservedRows]=await Promise.all([
    prisma.room.findMany({where,orderBy:[{floor:"asc"},{number:"asc"}]}),
    prisma.reservation.findMany({where:{status:"CONFIRMED",checkIn:{lt:tomorrow},OR:[{checkOut:{gt:today}},{checkOut:null}]},select:{roomId:true},distinct:["roomId"]})
  ]);
  const reservedIds=new Set(reservedRows.map(r=>r.roomId));
  const rooms=allRooms.map(room=>({...room,occupancyStatus:room.occupancyStatus==="RESERVED"&&!reservedIds.has(room.id)?"AVAILABLE":room.occupancyStatus,reservedToday:reservedIds.has(room.id)}));
  const filtered=req.query.occupancyStatus==="RESERVED"
    ? rooms.filter(room=>room.reservedToday&&["AVAILABLE","RESERVED"].includes(room.occupancyStatus))
    : req.query.occupancyStatus==="AVAILABLE"
      ? rooms.filter(room=>room.occupancyStatus==="AVAILABLE"&&!room.reservedToday)
      : req.query.occupancyStatus
        ? rooms.filter(room=>room.occupancyStatus===req.query.occupancyStatus)
        : rooms;
  res.json(filtered);
}));
app.post("/api/rooms", allow("ADMIN","MANAGER"), asyncRoute(async (req,res) => {
  const {number,floor,category,rate} = req.body;
  const type=String(category||"").toUpperCase();
  if (!number || !["STANDARD","DELUXE","SUITE"].includes(type) || rate == null || Number(rate)<0) return res.status(400).json({error:"Room number, valid room type and non-negative rate are required"});
  res.status(201).json(await prisma.room.create({data:{number:String(number).trim(),floor:Number(floor||1),category:type,rate:Number(rate)}}));
}));
app.post("/api/rooms/bulk", allow("ADMIN","MANAGER"), asyncRoute(async (req,res) => {
  const {startNumber,endNumber,floor,category,rate}=req.body;
  const start=String(startNumber||"").trim(),end=String(endNumber||"").trim();
  const matchStart=start.match(/^(.*?)(\d+)$/),matchEnd=end.match(/^(.*?)(\d+)$/);
  if(!matchStart||!matchEnd||matchStart[1]!==matchEnd[1])return res.status(400).json({error:"Enter a matching room range, such as 101 to 108"});
  const first=Number(matchStart[2]),last=Number(matchEnd[2]),count=last-first+1;
  if(!Number.isInteger(first)||!Number.isInteger(last)||count<1||count>50)return res.status(400).json({error:"Room range must contain between 1 and 50 rooms"});
  const type=String(category||"").toUpperCase();
  if(!["STANDARD","DELUXE","SUITE"].includes(type)||rate==null||Number(rate)<0)return res.status(400).json({error:"Choose a valid room type and non-negative rate"});
  const width=matchStart[2].length;
  const rows=Array.from({length:count},(_,i)=>({number:matchStart[1]+String(first+i).padStart(width,"0"),floor:Number(floor||1),category:type,rate:Number(rate)}));
  const result=await prisma.room.createMany({data:rows,skipDuplicates:true});
  res.status(201).json({created:result.count,skipped:count-result.count,message:`Added ${result.count} rooms; ${count-result.count} already existed`});
}));
app.post("/api/rooms/bulk-delete", allow("ADMIN","MANAGER"), asyncRoute(async (req,res) => {
  const roomIds=[...new Set((Array.isArray(req.body.roomIds)?req.body.roomIds:[]).filter(id=>typeof id==="string"))];
  if(!roomIds.length)return res.status(400).json({error:"Select at least one room"});
  const selected=await prisma.room.findMany({where:{id:{in:roomIds}},include:{reservations:{select:{id:true},take:1},tasks:{select:{id:true},take:1}}});
  if(selected.length!==roomIds.length)return res.status(404).json({error:"One or more selected rooms were not found. Refresh and try again."});
  const protectedRooms=selected.filter(room=>room.reservations.length||room.tasks.length);
  if(protectedRooms.length)return res.status(409).json({error:"Cannot delete rooms with reservation or housekeeping history: "+protectedRooms.map(room=>room.number).join(", ")+". Remove them from the selection and try again."});
  await prisma.room.deleteMany({where:{id:{in:roomIds}}});
  res.json({success:true,deleted:roomIds.length,message:roomIds.length+" room(s) removed"});
}));
app.delete("/api/rooms/:id", allow("ADMIN","MANAGER"), asyncRoute(async (req,res) => {
  const room=await prisma.room.findUnique({where:{id:req.params.id},include:{reservations:{select:{id:true},take:1},tasks:{select:{id:true},take:1}}});
  if(!room)return res.status(404).json({error:"Room not found"});
  if(room.reservations.length||room.tasks.length)return res.status(409).json({error:"This room has reservation or housekeeping history and cannot be deleted. Mark it Out of Order instead."});
  await prisma.room.delete({where:{id:req.params.id}});
  res.json({success:true});
}));
app.patch("/api/rooms/:id", allow("ADMIN","MANAGER","RECEPTIONIST"), asyncRoute(async (req,res) => {
  const allowed = ["floor","category","rate","notes"];
  const data = Object.fromEntries(Object.entries(req.body).filter(([key])=>allowed.includes(key)));
  res.json(await prisma.room.update({where:{id:req.params.id},data}));
}));

app.get("/api/reservations", allow("ADMIN","MANAGER","RECEPTIONIST"), asyncRoute(async (req,res) => {
  const where = {};
  if (req.query.status) where.status = req.query.status;
  if (req.query.source) where.source = req.query.source;
  if (req.query.date) { const d=dayStart(req.query.date); where.checkIn={gte:d,lt:dayEnd(d)}; }
  res.json(await prisma.reservation.findMany({where,include:{guest:true,room:true,payments:true,statusHistory:{orderBy:{changedAt:"asc"}}},orderBy:{checkIn:"asc"}}));
}));
app.post("/api/reservations", allow("ADMIN","MANAGER","RECEPTIONIST"), asyncRoute(async (req,res) => {
  const {guestId,roomId,checkIn,checkOut,totalAmount,adults,children,source,notes} = req.body;
  if (!guestId||!roomId||!checkIn) return res.status(400).json({error:"Guest, room and check-in are required"});
  const bookingSource=source||"WALK_IN";
  if(bookingSource!=="WALK_IN"&&(!checkOut||totalAmount==null||totalAmount==="")) return res.status(400).json({error:"Check-out and total amount are required for advance reservations"});
  const start=new Date(checkIn);
  if(!Number.isFinite(start.getTime())) return res.status(400).json({error:"Choose a valid check-in date"});
  const end=checkOut?new Date(checkOut):null;
  if(checkOut&&(!Number.isFinite(end.getTime())||!(end>start))) return res.status(400).json({error:"Check-out must be after check-in"});
  const room=await prisma.room.findUnique({where:{id:roomId}});
  if(!room) return res.status(404).json({error:"Room not found"});
  if(room.occupancyStatus==="OUT_OF_ORDER") return res.status(409).json({error:"This room is out of order"});
  if(bookingSource==="WALK_IN"&&room.occupancyStatus==="OCCUPIED") return res.status(409).json({error:"A walk-in must be assigned to a currently available room"});
  if(bookingSource!=="WALK_IN"&&room.occupancyStatus==="OCCUPIED"){
    const activeStay=await prisma.reservation.findFirst({where:{roomId,status:"CHECKED_IN"}});
    if(!activeStay?.checkOut||activeStay.checkOut>start) return res.status(409).json({error:"This room is currently occupied through the selected check-in date"});
  }
  const conflictEnd=end||new Date(start.getTime()+86400000);
  const conflict=await prisma.reservation.findFirst({where:{roomId,status:{in:["CONFIRMED","CHECKED_IN"]},checkIn:{lt:conflictEnd},OR:[{checkOut:{gt:start}},{checkOut:null}]}});
  if(conflict) return res.status(409).json({error:"This room already has a reservation for those dates"});
  const isWalkIn=bookingSource==="WALK_IN";
  const bookingCode="ST"+Date.now().toString().slice(-8);
  const reservation=await prisma.reservation.create({data:{bookingCode,guestId,roomId,checkIn:start,checkOut:end,totalAmount:totalAmount===""||totalAmount==null?null:Number(totalAmount),adults:adults===""||adults==null?1:Number(adults),children:children===""||children==null?0:Number(children),source:bookingSource,notes,status:isWalkIn?"CHECKED_IN":"CONFIRMED",checkedInAt:isWalkIn?new Date():null},include:{guest:true,room:true}});
  await prisma.reservationStatusHistory.create({data:{reservationId:reservation.id,fromStatus:null,toStatus:reservation.status,changedBy:req.user.fullName||req.user.email||"Staff"}});
  if(isWalkIn) await prisma.room.update({where:{id:roomId},data:{occupancyStatus:"OCCUPIED",housekeepingStatus:"CLEAN"}});
  res.status(201).json(reservation);
}));
app.patch("/api/reservations/:id/status", allow("ADMIN","MANAGER","RECEPTIONIST"), asyncRoute(async (req,res) => {
  const {status,totalAmount,extraCharges,discount}=req.body;
  const current=await prisma.reservation.findUnique({where:{id:req.params.id},include:{room:true}});
  if(!current) return res.status(404).json({error:"Reservation not found"});
  const transitions={
    PENDING:["CONFIRMED","CANCELLED"],
    CONFIRMED:["CHECKED_IN","CANCELLED","NO_SHOW"],
    CHECKED_IN:["CHECKED_OUT"],
    CHECKED_OUT:[],
    CANCELLED:[],
    NO_SHOW:[]
  };
  if(!transitions[current.status]?.includes(status)) return res.status(409).json({error:"That status change is not allowed. Follow the reservation's next available action."});
  let checkoutAmount,checkoutExtraCharges,checkoutDiscount;
  if(status==="CHECKED_OUT"){
    if(totalAmount===undefined||totalAmount===null||totalAmount==="") return res.status(400).json({error:"Enter the final amount before checking out"});
    checkoutAmount=Number(totalAmount);
    checkoutExtraCharges=Number(extraCharges??0);
    checkoutDiscount=Number(discount??0);
    if(!Number.isFinite(checkoutAmount)||checkoutAmount<0) return res.status(400).json({error:"Final amount must be a valid non-negative number"});
    if(!Number.isFinite(checkoutExtraCharges)||checkoutExtraCharges<0||!Number.isFinite(checkoutDiscount)||checkoutDiscount<0) return res.status(400).json({error:"Extra charges and discount must be valid non-negative amounts"});
  }
  const now=new Date();
  const todayKey=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata"}).format(now);
  const dateKey=value=>new Date(value).toISOString().slice(0,10);
  const arrivalKey=dateKey(current.checkIn);
  const departureKey=current.checkOut?dateKey(current.checkOut):null;
  if(status==="CONFIRMED"){
    if(current.room.occupancyStatus==="OUT_OF_ORDER") return res.status(409).json({error:"This room is out of order"});
    const conflict=await prisma.reservation.findFirst({where:{id:{not:current.id},roomId:current.roomId,status:{in:["CONFIRMED","CHECKED_IN"]},checkIn:current.checkOut?{lt:current.checkOut}:undefined,OR:[{checkOut:{gt:current.checkIn}},{checkOut:null}]}});
    if(conflict) return res.status(409).json({error:"This room already has a reservation for overlapping dates"});
  }
  if(status==="CHECKED_IN"){
    if(todayKey<arrivalKey) return res.status(409).json({error:"This guest is not due to check in yet"});
    if(departureKey&&todayKey>=departureKey) return res.status(409).json({error:"The check-in date has already passed for this stay. Contact a manager to resolve the booking."});
    if(current.room.occupancyStatus==="OUT_OF_ORDER"||current.room.occupancyStatus==="OCCUPIED") return res.status(409).json({error:"This room is not currently available for check-in"});
    if(current.room.housekeepingStatus!=="CLEAN") return res.status(409).json({error:"This room must be marked Clean by housekeeping before check-in"});
    const conflict=await prisma.reservation.findFirst({where:{id:{not:current.id},roomId:current.roomId,status:{in:["CONFIRMED","CHECKED_IN"]},checkIn:current.checkOut?{lt:current.checkOut}:undefined,OR:[{checkOut:{gt:now}},{checkOut:null}]}});
    if(conflict) return res.status(409).json({error:"Another reservation currently overlaps this room. Resolve the room schedule before check-in."});
  }
  if(status==="NO_SHOW"&&todayKey<=arrivalKey) return res.status(409).json({error:"A reservation can be marked no-show only after its check-in date has passed"});
  const updated=await prisma.$transaction(async tx=>{
    const r=await tx.reservation.update({where:{id:current.id},data:{status,checkedInAt:status==="CHECKED_IN"?now:undefined,checkedOutAt:status==="CHECKED_OUT"?now:undefined,checkOut:status==="CHECKED_OUT"&&!current.checkOut?new Date(`${todayKey}T00:00:00.000+05:30`):undefined,totalAmount:status==="CHECKED_OUT"?checkoutAmount:undefined,extraCharges:status==="CHECKED_OUT"?checkoutExtraCharges:undefined,discount:status==="CHECKED_OUT"?checkoutDiscount:undefined},include:{room:true}});
    await tx.reservationStatusHistory.create({data:{reservationId:r.id,fromStatus:current.status,toStatus:status,changedBy:req.user.fullName||req.user.email||"Staff"}});
    if(status==="CHECKED_IN") await tx.room.update({where:{id:r.roomId},data:{occupancyStatus:"OCCUPIED"}});
    if(status==="CHECKED_OUT") await tx.room.update({where:{id:r.roomId},data:{occupancyStatus:"AVAILABLE",housekeepingStatus:"DIRTY"}});
    return r;
  });
  res.json(updated);
}));

app.get("/api/guests", allow("ADMIN","MANAGER","RECEPTIONIST"), asyncRoute(async (_req,res)=>res.json(await prisma.guest.findMany({orderBy:{createdAt:"desc"}}))));
app.post("/api/guests", allow("ADMIN","MANAGER","RECEPTIONIST"), asyncRoute(async (req,res)=>{
  const {fullName,phone,email,idType,idNumber}=req.body;
  if(!fullName||!phone) return res.status(400).json({error:"Guest name and phone are required"});
  res.status(201).json(await prisma.guest.create({data:{fullName,phone,email,idType,idNumber}}));
}));

app.get("/api/housekeeping", allow("ADMIN","MANAGER","HOUSEKEEPING"), asyncRoute(async (req,res)=>{
  const where={};
  if(req.query.status) where.status=req.query.status;
  if(req.query.date){const d=dayStart(req.query.date);where.scheduledAt={gte:d,lt:dayEnd(d)};}
  res.json(await prisma.housekeepingTask.findMany({where,include:{room:true},orderBy:{scheduledAt:"desc"}}));
}));
app.post("/api/housekeeping", allow("ADMIN","MANAGER","HOUSEKEEPING"), asyncRoute(async (req,res)=>{
  const {roomId,description,assignedTo,scheduledAt,taskType}=req.body;
  if(!roomId||!String(description||"").trim()) return res.status(400).json({error:"Room and task description are required"});
  const room=await prisma.room.findUnique({where:{id:roomId}});
  if(!room) return res.status(404).json({error:"Room not found"});
  const scheduled=scheduledAt?new Date(scheduledAt):new Date();
  if(Number.isNaN(scheduled.getTime())) return res.status(400).json({error:"Enter a valid scheduled date and time"});
  if(assignedTo){
    const cleaner=await prisma.user.findFirst({where:{fullName:assignedTo,role:"HOUSEKEEPING",active:true}});
    if(!cleaner) return res.status(400).json({error:"Choose an active housekeeping staff member"});
  }
  const result=await prisma.$transaction(async tx=>{
    const task=await tx.housekeepingTask.create({data:{roomId,description:String(description).trim(),assignedTo:assignedTo||null,taskType:taskType||"DAILY_CLEANING",scheduledAt:scheduled},include:{room:true}});
    const active=await tx.housekeepingTask.count({where:{roomId,status:"IN_PROGRESS"}});
    await tx.room.update({where:{id:roomId},data:{housekeepingStatus:active?"CLEANING":"DIRTY"}});
    return {...task,room:{...task.room,housekeepingStatus:active?"CLEANING":"DIRTY"}};
  });
  res.status(201).json(result);
}));
app.post("/api/housekeeping/generate-daily", allow("ADMIN","MANAGER","HOUSEKEEPING"), asyncRoute(async (_req,res)=>{
  const today=dayStart(), tomorrow=dayEnd();
  const occupied=await prisma.room.findMany({where:{occupancyStatus:"OCCUPIED"}});
  let created=0;
  for(const room of occupied){
    const existing=await prisma.housekeepingTask.findFirst({where:{roomId:room.id,taskType:"DAILY_CLEANING",scheduledAt:{gte:today,lt:tomorrow}}});
    if(!existing){await prisma.housekeepingTask.create({data:{roomId:room.id,taskType:"DAILY_CLEANING",description:"Daily occupied-room cleaning"}});created++;}
  }
  res.json({created,message:`Created ${created} daily cleaning tasks`});
}));
app.patch("/api/housekeeping/:id/assign", allow("ADMIN","MANAGER","HOUSEKEEPING"), asyncRoute(async (req,res)=>{
  const {assignedTo}=req.body;
  const task=await prisma.housekeepingTask.findUnique({where:{id:req.params.id}});
  if(!task) return res.status(404).json({error:"Housekeeping task not found"});
  if(task.status!=="PENDING") return res.status(409).json({error:"Only pending tasks can be reassigned"});
  if(assignedTo){
    const cleaner=await prisma.user.findFirst({where:{fullName:assignedTo,role:"HOUSEKEEPING",active:true}});
    if(!cleaner) return res.status(400).json({error:"Choose an active housekeeping staff member"});
  }
  res.json(await prisma.housekeepingTask.update({where:{id:task.id},data:{assignedTo:assignedTo||null},include:{room:true}}));
}));

app.patch("/api/housekeeping/:id/status", allow("ADMIN","MANAGER","HOUSEKEEPING"), asyncRoute(async (req,res)=>{
  const {status}=req.body;
  if(!["IN_PROGRESS","COMPLETED"].includes(status)) return res.status(400).json({error:"Use the Start Cleaning or Mark as Completed action"});
  const result=await prisma.$transaction(async tx=>{
    const current=await tx.housekeepingTask.findUnique({where:{id:req.params.id}});
    if(!current) return {error:"Housekeeping task not found",statusCode:404};
    if(status==="IN_PROGRESS"&&current.status!=="PENDING") return {error:"Only pending tasks can be started",statusCode:409};
    if(status==="COMPLETED"&&current.status!=="IN_PROGRESS") return {error:"Only a task in progress can be completed",statusCode:409};
    if(status==="IN_PROGRESS"&&!current.assignedTo) return {error:"Assign a cleaner before starting this task",statusCode:409};
    const task=await tx.housekeepingTask.update({where:{id:current.id},data:{status,startedAt:status==="IN_PROGRESS"?new Date():undefined,completedAt:status==="COMPLETED"?new Date():undefined}});
    const openTasks=await tx.housekeepingTask.findMany({where:{roomId:task.roomId,status:{not:"COMPLETED"}},select:{status:true}});
    const housekeepingStatus=openTasks.some(t=>t.status==="IN_PROGRESS")?"CLEANING":openTasks.length?"DIRTY":"CLEAN";
    await tx.room.update({where:{id:task.roomId},data:{housekeepingStatus}});
    return {task,room:await tx.room.findUnique({where:{id:task.roomId}})};
  });
  if(result.error) return res.status(result.statusCode).json({error:result.error});
  res.json({...result.task,room:result.room});
}));

app.get("/api/payments", allow("ADMIN","MANAGER","RECEPTIONIST"), asyncRoute(async (_req,res)=>res.json(await prisma.payment.findMany({include:{guest:true,reservation:true},orderBy:{paidAt:"desc"}}))));
app.post("/api/payments", allow("ADMIN","MANAGER","RECEPTIONIST"), asyncRoute(async (req,res)=>{
  const {guestId,reservationId,amount,method,reference}=req.body;
  if(!guestId||amount==null||!["CASH","UPI","CARD","ONLINE"].includes(method)) return res.status(400).json({error:"Guest, amount and valid payment method are required"});
  res.status(201).json(await prisma.payment.create({data:{paymentCode:"PAY"+Date.now().toString().slice(-8),guestId,reservationId:reservationId||null,amount,method,reference},include:{guest:true}}));
}));

app.get("/api/room-rack", allow("ADMIN","MANAGER","RECEPTIONIST"), asyncRoute(async (req,res)=>{
  const mode=["daily","weekly","monthly"].includes(req.query.mode)?req.query.mode:"daily";
  const start=dayStart(req.query.date||new Date());
  const days=mode==="daily"?1:mode==="weekly"?7:30;
  const end=new Date(start);end.setDate(end.getDate()+days);
  const [rooms,reservations]=await Promise.all([
    prisma.room.findMany({orderBy:[{floor:"asc"},{number:"asc"}]}),
    prisma.reservation.findMany({where:{checkIn:{lt:end},OR:[{checkOut:{gt:start}},{checkOut:null}],status:{in:["CONFIRMED","CHECKED_IN"]}},include:{guest:true}})
  ]);
  const dates=Array.from({length:days},(_,i)=>{const d=new Date(start);d.setDate(d.getDate()+i);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,"0"),String(d.getDate()).padStart(2,"0")].join("-");});
  res.json({mode,dates,rooms:rooms.map(room=>({...room,reservations:reservations.filter(r=>r.roomId===room.id)}))});
}));

app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:err.code==="P2002"?"That record already exists": "Server error. Check the server logs."});});
app.get("/api/staff",allow("ADMIN","MANAGER","HOUSEKEEPING"),asyncRoute(async(_req,res)=>res.json(await prisma.user.findMany({select:{id:true,fullName:true,email:true,role:true,active:true,createdAt:true},orderBy:{createdAt:"desc"}}))));
app.post("/api/staff",allow("ADMIN"),asyncRoute(async(req,res)=>{const {fullName,email,password,role}=req.body;if(!fullName||!email||!password||!["ADMIN","MANAGER","RECEPTIONIST","HOUSEKEEPING"].includes(role))return res.status(400).json({error:"Name, email, password and valid role are required"});const passwordHash=await bcrypt.hash(password,12);const user=await prisma.user.create({data:{fullName,email:String(email).toLowerCase(),passwordHash,role},select:{id:true,fullName:true,email:true,role:true,active:true}});res.status(201).json(user);}));
app.patch("/api/staff/:id/active",allow("ADMIN"),asyncRoute(async(req,res)=>{if(req.params.id===req.user.id&&req.body.active===false)return res.status(400).json({error:"You cannot deactivate your own account"});res.json(await prisma.user.update({where:{id:req.params.id},data:{active:Boolean(req.body.active)},select:{id:true,fullName:true,email:true,role:true,active:true}}));}));
app.listen(port,()=>console.log("StaySuite API running on http://localhost:"+port));