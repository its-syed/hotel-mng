import "dotenv/config";
import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createServer } from "node:http";
import { Server } from "socket.io";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer,{cors:{origin:true}});
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
const jwtSecret=JWT_SECRET||"development-only-change-me";
io.use(async(socket,next)=>{
 try{
  const token=socket.handshake.auth?.token;
  if(!token&&process.env.DEV_AUTH_BYPASS==="true"){socket.data.kind="staff";return next();}
  if(!token)return next(new Error("Authentication required"));
  const payload=jwt.verify(token,jwtSecret);
  if(payload.type==="guest"){
   const account=await prisma.guestAccount.findUnique({where:{id:payload.sub}});
   if(!account||!account.active)return next(new Error("Guest account is inactive"));
   socket.data.kind="guest";socket.data.guestAccountId=account.id;return next();
  }
  const user=await prisma.user.findUnique({where:{id:payload.sub},include:{roleRecord:true}});
  if(!user||!user.active)return next(new Error("Staff account is inactive"));
  const permissions=Array.isArray(user.roleRecord?.permissions)?user.roleRecord.permissions:[];
  if(user.role!=="ADMIN"&&!permissions.includes("*")&&!permissions.includes("reservations.view"))return next(new Error("Not authorized"));
  socket.data.kind="staff";return next();
 }catch{return next(new Error("Unauthorized"));}
});
io.on("connection",socket=>{
 if(socket.data.kind==="guest")socket.join("guest:"+socket.data.guestAccountId);
 if(socket.data.kind==="staff")socket.join("staff:reservations");
});

const tokenFor=user=>jwt.sign({sub:user.id,role:user.role,email:user.email},jwtSecret,{expiresIn:"12h"});
const guestTokenFor=account=>jwt.sign({sub:account.id,type:"guest"},jwtSecret,{expiresIn:"30d"});
const guestAuthenticate=asyncRoute(async(req,res,next)=>{
 const token=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
 if(!token)return res.status(401).json({error:"Please sign in to your guest account"});
 try{
  const payload=jwt.verify(token,jwtSecret);
  if(payload.type!=="guest")return res.status(401).json({error:"Invalid guest session"});
  const account=await prisma.guestAccount.findUnique({where:{id:payload.sub}});
  if(!account||!account.active)return res.status(401).json({error:"Guest account is inactive"});
  req.guestAccount=account;next();
 }catch{return res.status(401).json({error:"Your guest session expired. Please sign in again"});}
});
const guestAccountFromRequest=async(req,res)=>{
 const token=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
 if(!token)return null;
 try{
  const payload=jwt.verify(token,jwtSecret);
  if(payload.type!=="guest")throw new Error("Invalid guest session");
  const account=await prisma.guestAccount.findUnique({where:{id:payload.sub}});
  if(!account||!account.active)throw new Error("Guest account is inactive");
  return account;
 }catch{res.status(401).json({error:"Your guest session is invalid. Please sign in again"});return null;}
};
const normalizePhone=value=>String(value||"").replace(/\D/g,"");
const isValidIndianMobile=value=>/^[6-9]\d{9}$/.test(normalizePhone(value));
const setBranchContext=async(req,user)=>{
 const assignments=(user.branchAssignments||[]).filter(a=>a.branch?.active);
 req.organizationId=user.organizationId||null;
 if(user.role==="ADMIN"){
  const requested=String(req.headers["x-branch-id"]||"").trim();
  if(requested){
   const branch=await prisma.branch.findFirst({where:{id:requested,organizationId:user.organizationId,active:true}});
   if(!branch)throw new Error("The selected branch is not available in this organization");
   req.branchId=branch.id;req.branch=branch;
  }else{req.branchId=null;req.branch=null;}
  return;
 }
 if(!assignments.length)throw new Error("Your account is not assigned to an active branch. Contact the administrator.");
 const branch=assignments[0].branch;
 req.branchId=branch.id;req.branch=branch;
};
const authenticate=asyncRoute(async(req,res,next)=>{
 if(process.env.DEV_AUTH_BYPASS==="true"){
  const organization=await prisma.organization.findFirst({include:{branches:{where:{active:true},orderBy:{createdAt:"asc"}}}});
  const user={id:"dev-admin",fullName:"Development Admin",email:"dev@ezystay.local",role:"ADMIN",active:true,permissions:["*"],organizationId:organization?.id||null};
  req.user=user;await setBranchContext(req,user);return next();
 }
 const token=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
 if(!token)return res.status(401).json({error:"Please sign in"});
 try{
  const payload=jwt.verify(token,JWT_SECRET||"development-only-change-me");
  const user=await prisma.user.findUnique({where:{id:payload.sub},include:{roleRecord:true,branchAssignments:{include:{branch:true}}}});
  if(!user||!user.active)return res.status(401).json({error:"Account is inactive"});
  user.permissions=Array.isArray(user.roleRecord?.permissions)?user.roleRecord.permissions:[];
  await setBranchContext(req,user);
  req.user=user;next();
 }catch(error){return res.status(401).json({error:error.message||"Session expired. Please sign in again"});}
});
const allow=(permission)=>(req,res,next)=>{
 const permissions=req.user?.permissions||[];
 if(req.user?.role==="ADMIN"||permissions.includes("*")||permissions.includes(permission))return next();
 return res.status(403).json({error:"Your role does not have permission to perform this action",requiredPermission:permission});
};
const branchScope=req=>req.branchId?{branchId:req.branchId}:req.user?.role==="ADMIN"?{}:{branchId:"__no_branch_access__"};
const requireBranchContext=(req,res,next)=>req.branchId?next():res.status(409).json({error:"Select an individual branch before performing this action"});
app.post("/api/auth/login",asyncRoute(async(req,res)=>{
 const {email,password}=req.body;if(!email||!password)return res.status(400).json({error:"Email and password are required"});
 const user=await prisma.user.findUnique({where:{email:String(email).toLowerCase()},include:{branchAssignments:{include:{branch:true}}}});
 if(!user||!user.active||!(await bcrypt.compare(password,user.passwordHash)))return res.status(401).json({error:"Invalid email or password"});
 const roleRecord=user.roleId?await prisma.role.findUnique({where:{id:user.roleId}}):await prisma.role.findUnique({where:{key:user.role}});
 const branches=user.role==="ADMIN"?await prisma.branch.findMany({where:{organizationId:user.organizationId,active:true},orderBy:{name:"asc"}}):user.branchAssignments.filter(a=>a.branch.active).map(a=>a.branch);
 res.json({token:tokenFor(user),user:{id:user.id,fullName:user.fullName,email:user.email,role:user.role,roleId:user.roleId,organizationId:user.organizationId,permissions:Array.isArray(roleRecord?.permissions)?roleRecord.permissions:[],branches,isAdmin:user.role==="ADMIN"}});
}));
app.get("/api/auth/me",authenticate,asyncRoute(async(req,res)=>{
 const branches=req.user.role==="ADMIN"?await prisma.branch.findMany({where:{organizationId:req.user.organizationId,active:true},orderBy:{name:"asc"}}):(req.user.branchAssignments||[]).filter(a=>a.branch.active).map(a=>a.branch);
 res.json({id:req.user.id,fullName:req.user.fullName,email:req.user.email,role:req.user.role,roleId:req.user.roleId,organizationId:req.user.organizationId,permissions:req.user.permissions||[],branches,isAdmin:req.user.role==="ADMIN",activeBranchId:req.branchId});
}));

app.post("/api/guest/auth/register",asyncRoute(async(req,res)=>{
 const fullName=String(req.body.fullName||"").trim();
 const phone=normalizePhone(req.body.phone);
 const email=String(req.body.email||"").trim().toLowerCase();
 const password=String(req.body.password||"");
 if(!fullName||!isValidIndianMobile(phone)||!/^\S+@\S+\.\S+$/.test(email)||password.length<8)
  return res.status(400).json({error:"Enter your name, a valid phone number, email and a password of at least 8 characters"});
 const existing=await prisma.guestAccount.findFirst({where:{OR:[{email},{phone}]}});
 if(existing)return res.status(409).json({error:"An account already exists with this email or phone number. Please sign in instead."});
 const account=await prisma.guestAccount.create({data:{fullName,phone,email,passwordHash:await bcrypt.hash(password,12)}});
 res.status(201).json({token:guestTokenFor(account),user:{id:account.id,fullName:account.fullName,phone:account.phone,email:account.email}});
}));
app.post("/api/guest/auth/login",asyncRoute(async(req,res)=>{
 const email=String(req.body.email||"").trim().toLowerCase();
 const password=String(req.body.password||"");
 if(!email||!password)return res.status(400).json({error:"Email and password are required"});
 const account=await prisma.guestAccount.findUnique({where:{email}});
 if(!account||!account.active||!(await bcrypt.compare(password,account.passwordHash)))return res.status(401).json({error:"Invalid email or password"});
 res.json({token:guestTokenFor(account),user:{id:account.id,fullName:account.fullName,phone:account.phone,email:account.email}});
}));
app.get("/api/guest/me",guestAuthenticate,(req,res)=>res.json({id:req.guestAccount.id,fullName:req.guestAccount.fullName,phone:req.guestAccount.phone,email:req.guestAccount.email}));
app.get("/api/guest/bookings",guestAuthenticate,asyncRoute(async(req,res)=>{
 const guests=await prisma.guest.findMany({where:{guestAccountId:req.guestAccount.id},include:{reservations:{include:{room:true},orderBy:{createdAt:"desc"}}}});
 const bookings=guests.flatMap(g=>g.reservations.map(r=>({bookingCode:r.bookingCode,status:r.status,guest:g.fullName,room:r.room.number,category:r.room.category,checkIn:r.checkIn,checkOut:r.checkOut,totalAmount:r.totalAmount,adults:r.adults,children:r.children,createdAt:r.createdAt}))).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
 res.json({bookings});
}));

const guestOtpStore=new Map();
const guestOtpEnabled=process.env.NODE_ENV!=="production"&&process.env.DEV_GUEST_OTP==="true";
app.post("/api/public/guest-otp/request",asyncRoute(async(req,res)=>{
 const phone=normalizePhone(req.body.phone);
 if(!isValidIndianMobile(phone))return res.status(400).json({error:"Enter a valid 10-digit Indian mobile number starting with 6, 7, 8 or 9"});
 if(!guestOtpEnabled)return res.status(503).json({error:"Phone verification is not configured yet. Please use your booking reference or sign in to your guest account."});
 const previous=guestOtpStore.get(phone);
 if(previous&&Date.now()-previous.sentAt<30000)return res.status(429).json({error:"Please wait 30 seconds before requesting another code"});
 guestOtpStore.set(phone,{code:"123456",sentAt:Date.now(),expiresAt:Date.now()+10*60*1000,attempts:0});
 res.json({success:true,message:"Development OTP generated. Use 123456 to test.",devOtp:"123456"});
}));
app.post("/api/public/guest-otp/verify",asyncRoute(async(req,res)=>{
 const phone=normalizePhone(req.body.phone),code=String(req.body.code||"").trim();
 const saved=guestOtpStore.get(phone);
 if(!saved||saved.expiresAt<Date.now()||saved.attempts>=5)return res.status(400).json({error:"Your code has expired. Request a new code."});
 if(code!==saved.code){saved.attempts+=1;return res.status(400).json({error:"That verification code is incorrect"});}
 guestOtpStore.delete(phone);
 const candidates=await prisma.guest.findMany({where:{phone:{contains:phone.slice(-10)}},include:{reservations:{include:{room:true},orderBy:{createdAt:"desc"}}}});
 const matching=candidates.filter(g=>normalizePhone(g.phone)===phone||normalizePhone(g.phone).slice(-10)===phone.slice(-10));
 const bookings=matching.flatMap(g=>g.reservations.map(r=>({bookingCode:r.bookingCode,status:r.status,guest:g.fullName,room:r.room.number,category:r.room.category,checkIn:r.checkIn,checkOut:r.checkOut,totalAmount:r.totalAmount,adults:r.adults,children:r.children,createdAt:r.createdAt}))).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
 res.json({success:true,bookings});
}));

app.get("/api/public/availability",asyncRoute(async(req,res)=>{
 const {checkIn,checkOut}=req.query;const start=new Date(checkIn),end=new Date(checkOut);
 if(!checkIn||!checkOut||!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<=start)return res.status(400).json({error:"Choose valid check-in and check-out dates"});
 const rooms=await prisma.room.findMany({where:{archivedAt:null,occupancyStatus:{not:"OUT_OF_ORDER"}},orderBy:[{floor:"asc"},{number:"asc"}]});
 const conflicts=await prisma.reservation.findMany({where:{status:{in:["CONFIRMED","CHECKED_IN"]},checkIn:{lt:end},OR:[{checkOut:{gt:start}},{checkOut:null}]},select:{roomId:true}});
 const busy=new Set(conflicts.map(x=>x.roomId));
 const occupiedIds=rooms.filter(r=>r.occupancyStatus==="OCCUPIED").map(r=>r.id);
 const activeStayRows=occupiedIds.length?await prisma.reservation.findMany({where:{roomId:{in:occupiedIds},status:"CHECKED_IN"},select:{roomId:true}}):[];
 const activeStayRooms=new Set(activeStayRows.map(x=>x.roomId));
 res.json(rooms.filter(r=>!busy.has(r.id)&&(r.occupancyStatus!=="OCCUPIED"||activeStayRooms.has(r.id))).map(r=>({id:r.id,number:r.number,category:r.category,rate:r.rate})));
}));
app.post("/api/public/bookings",asyncRoute(async(req,res)=>{
 const account=await guestAccountFromRequest(req,res);if(res.headersSent)return;
 if(!account)return res.status(401).json({error:"Please sign in or create an EzyStay account before booking"});
 const fullName=account.fullName;
 const phone=account.phone;
 const email=account.email;
 const {roomId,checkIn,checkOut,adults,children}=req.body;const start=new Date(checkIn),end=new Date(checkOut);
 if(!fullName||!isValidIndianMobile(phone)||!roomId||!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<=start)return res.status(400).json({error:"A valid Indian mobile number and valid stay dates are required"});
 const room=await prisma.room.findFirst({where:{id:roomId,...branchScope(req)}});
 if(!room||room.archivedAt||room.occupancyStatus==="OUT_OF_ORDER")return res.status(404).json({error:"Room is not available"});
 if(room.occupancyStatus==="OCCUPIED"){
  const activeStay=await prisma.reservation.findFirst({where:{roomId,status:"CHECKED_IN"}});
  if(!activeStay?.checkOut||activeStay.checkOut>start)return res.status(409).json({error:"This room is currently occupied through the selected check-in date"});
 }
 const conflict=await prisma.reservation.findFirst({where:{roomId,status:{in:["CONFIRMED","CHECKED_IN"]},checkIn:{lt:end},OR:[{checkOut:{gt:start}},{checkOut:null}]}});
 if(conflict)return res.status(409).json({error:"This room was just booked. Please search again."});
 const nights=Math.max(1,Math.ceil((end-start)/86400000));
 const result=await prisma.$transaction(async tx=>{let guest=await tx.guest.findFirst({where:{guestAccountId:account.id},orderBy:{createdAt:"asc"}});if(guest){guest=await tx.guest.update({where:{id:guest.id},data:{fullName,phone,email:email||null}})}else{guest=await tx.guest.create({data:{fullName,phone,email:email||null,guestAccountId:account.id}})}const reservation=await tx.reservation.create({data:{bookingCode:"WEB"+Date.now().toString().slice(-8),guestId:guest.id,roomId,checkIn:start,checkOut:end,adults:Number(adults||1),children:Number(children||0),totalAmount:Number(room.rate)*nights,status:"PENDING",source:"WEBSITE",notes:"Public website booking request"},include:{room:true,guest:true}});await tx.reservationStatusHistory.create({data:{reservationId:reservation.id,fromStatus:null,toStatus:"PENDING",changedBy:"Customer website"}});return reservation;});
 io.to("staff:reservations").emit("reservation:created",{id:result.id,bookingCode:result.bookingCode});
 res.status(201).json({bookingCode:result.bookingCode,status:result.status,guest:result.guest.fullName,room:result.room.number,totalAmount:result.totalAmount,message:"Your booking request has been received. The hotel will confirm it shortly."});
}));
app.post("/api/public/booking-status",asyncRoute(async(req,res)=>{
 const code=String(req.body.bookingCode||"").trim().toUpperCase();
 if(!code||code.length>40)return res.status(400).json({error:"Enter a valid booking reference number"});
 const booking=await prisma.reservation.findUnique({where:{bookingCode:code},include:{room:true}});
 if(!booking)return res.status(404).json({error:"We couldn't find a booking with that reference number. Check it and try again."});
 res.json({bookingCode:booking.bookingCode,status:booking.status,room:booking.room.number,category:booking.room.category,checkIn:booking.checkIn,checkOut:booking.checkOut});
}));
app.use("/api",(req,res,next)=>{if(req.path.startsWith("/auth/")||req.path.startsWith("/public/"))return next();authenticate(req,res,next);});

const adminOnly=(req,res,next)=>req.user?.role==="ADMIN"?next():res.status(403).json({error:"Only an organization administrator can manage branches"});
app.get("/api/branches",adminOnly,asyncRoute(async(req,res)=>{
 if(!req.organizationId)return res.status(409).json({error:"This account is not linked to an organization yet"});
 res.json(await prisma.branch.findMany({where:{organizationId:req.organizationId},orderBy:[{active:"desc"},{name:"asc"}]}));
}));
app.post("/api/branches",adminOnly,asyncRoute(async(req,res)=>{
 const name=String(req.body.name||"").trim(),code=String(req.body.code||"").trim().toUpperCase();
 if(!name||!code)return res.status(400).json({error:"Branch name and code are required"});
 if(!req.organizationId)return res.status(409).json({error:"This account is not linked to an organization yet"});
 const branch=await prisma.branch.create({data:{organizationId:req.organizationId,name,code,address:String(req.body.address||"").trim()||null,phone:String(req.body.phone||"").trim()||null,email:String(req.body.email||"").trim().toLowerCase()||null}});
 res.status(201).json(branch);
}));
app.patch("/api/branches/:id",adminOnly,asyncRoute(async(req,res)=>{
 const current=await prisma.branch.findFirst({where:{id:req.params.id,organizationId:req.organizationId}});
 if(!current)return res.status(404).json({error:"Branch not found"});
 const data={};
 for(const key of ["name","address","phone"])if(req.body[key]!==undefined)data[key]=String(req.body[key]||"").trim()||null;
 if(req.body.email!==undefined)data.email=String(req.body.email||"").trim().toLowerCase()||null;
 if(req.body.active!==undefined)data.active=Boolean(req.body.active);
 res.json(await prisma.branch.update({where:{id:current.id},data}));
}));
app.get("/api/branches/context",asyncRoute(async(req,res)=>{
 res.json({activeBranchId:req.branchId,branch:req.branch||null,isAdmin:req.user.role==="ADMIN",branches:req.user.role==="ADMIN"?await prisma.branch.findMany({where:{organizationId:req.organizationId,active:true},orderBy:{name:"asc"}}):(req.user.branchAssignments||[]).filter(a=>a.branch.active).map(a=>a.branch)});
}));



app.get("/api/dashboard", allow("dashboard.view"), asyncRoute(async (req,res) => {
  const branch=branchScope(req);
  const today = dayStart();
  const tomorrow = dayEnd();
  const [total, occupied, availableBase, outOfOrder, clean, dirty, cleaning, arrivals, departures, checkIns, checkOuts, tasks, reservedTodayRows] = await Promise.all([
    prisma.room.count({where:{...branch,archivedAt:null}}), prisma.room.count({where:{...branch,archivedAt:null,occupancyStatus:"OCCUPIED"}}),
    prisma.room.count({where:{...branch,archivedAt:null,occupancyStatus:{in:["AVAILABLE","RESERVED"]}}}), prisma.room.count({where:{...branch,archivedAt:null,occupancyStatus:"OUT_OF_ORDER"}}),
    prisma.room.count({where:{...branch,archivedAt:null,housekeepingStatus:"CLEAN"}}),
    prisma.room.count({where:{...branch,archivedAt:null,housekeepingStatus:"DIRTY"}}), prisma.room.count({where:{...branch,archivedAt:null,housekeepingStatus:"CLEANING"}}),
    prisma.reservation.count({where:{...branch,checkIn:{gte:today,lt:tomorrow},status:"CONFIRMED"}}),
    prisma.reservation.count({where:{...branch,checkOut:{gte:today,lt:tomorrow},status:{in:["CONFIRMED","CHECKED_IN"]}}}),
    prisma.reservation.count({where:{...branch,checkedInAt:{gte:today,lt:tomorrow}}}),
    prisma.reservation.count({where:{...branch,checkedOutAt:{gte:today,lt:tomorrow}}}),
    prisma.housekeepingTask.count({where:{...branch,scheduledAt:{gte:today,lt:tomorrow},status:{not:"COMPLETED"}}}),
    prisma.reservation.findMany({where:{...branch,status:"CONFIRMED",checkIn:{lt:tomorrow},OR:[{checkOut:{gt:today}},{checkOut:null}]},select:{roomId:true},distinct:["roomId"]})
  ]);
  const reserved=await prisma.room.count({where:{id:{in:reservedTodayRows.map(r=>r.roomId)},occupancyStatus:{in:["AVAILABLE","RESERVED"]}}});
  const available=Math.max(0,availableBase-reserved);
  res.json({rooms:{total,occupied,available,reserved,outOfOrder},housekeeping:{clean,dirty,cleaning},arrivals,departures,checkIns,checkOuts,pendingTasks:tasks});
}));

app.get("/api/rooms", allow("rooms.view"), asyncRoute(async (req,res) => {
  const where = {...branchScope(req),archivedAt:req.query.archived==="true"?{not:null}:null};
  if (req.query.housekeepingStatus) where.housekeepingStatus = req.query.housekeepingStatus;
  if (req.query.floor) where.floor = Number(req.query.floor);
  const today=dayStart(), tomorrow=dayEnd();
  const [allRooms,reservedRows]=await Promise.all([
    prisma.room.findMany({where,orderBy:[{floor:"asc"},{number:"asc"}]}),
    prisma.reservation.findMany({where:{...branchScope(req),status:"CONFIRMED",checkIn:{lt:tomorrow},OR:[{checkOut:{gt:today}},{checkOut:null}]},select:{roomId:true},distinct:["roomId"]})
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
app.post("/api/rooms", allow("rooms.create"), requireBranchContext, asyncRoute(async (req,res) => {
  const {number,floor,category,rate} = req.body;
  const type=String(category||"").toUpperCase();
  if (!number || !["STANDARD","DELUXE","SUITE"].includes(type) || rate == null || Number(rate)<0) return res.status(400).json({error:"Room number, valid room type and non-negative rate are required"});
  res.status(201).json(await prisma.room.create({data:{branchId:req.branchId,number:String(number).trim(),floor:Number(floor||1),category:type,rate:Number(rate)}}));
}));
app.post("/api/rooms/bulk", allow("rooms.create"), requireBranchContext, asyncRoute(async (req,res) => {
  const {startNumber,endNumber,floor,category,rate}=req.body;
  const start=String(startNumber||"").trim(),end=String(endNumber||"").trim();
  const matchStart=start.match(/^(.*?)(\d+)$/),matchEnd=end.match(/^(.*?)(\d+)$/);
  if(!matchStart||!matchEnd||matchStart[1]!==matchEnd[1])return res.status(400).json({error:"Enter a matching room range, such as 101 to 108"});
  const first=Number(matchStart[2]),last=Number(matchEnd[2]),count=last-first+1;
  if(!Number.isInteger(first)||!Number.isInteger(last)||count<1||count>50)return res.status(400).json({error:"Room range must contain between 1 and 50 rooms"});
  const type=String(category||"").toUpperCase();
  if(!["STANDARD","DELUXE","SUITE"].includes(type)||rate==null||Number(rate)<0)return res.status(400).json({error:"Choose a valid room type and non-negative rate"});
  const width=matchStart[2].length;
  const rows=Array.from({length:count},(_,i)=>({branchId:req.branchId,number:matchStart[1]+String(first+i).padStart(width,"0"),floor:Number(floor||1),category:type,rate:Number(rate)}));
  const result=await prisma.room.createMany({data:rows,skipDuplicates:true});
  res.status(201).json({created:result.count,skipped:count-result.count,message:`Added ${result.count} rooms; ${count-result.count} already existed`});
}));
app.post("/api/rooms/bulk-archive", allow("rooms.delete"), requireBranchContext, asyncRoute(async (req,res) => {
  const roomIds=[...new Set((Array.isArray(req.body.roomIds)?req.body.roomIds:[]).filter(id=>typeof id==="string"))];
  if(!roomIds.length)return res.status(400).json({error:"Select at least one room"});
  const selected=await prisma.room.findMany({where:{...branchScope(req),id:{in:roomIds},archivedAt:null},include:{reservations:{where:{status:{in:["PENDING","CONFIRMED","CHECKED_IN"]}},select:{id:true},take:1},tasks:{where:{status:{not:"COMPLETED"}},select:{id:true},take:1}}});
  if(selected.length!==roomIds.length)return res.status(404).json({error:"One or more selected rooms were not found or are already archived. Refresh and try again."});
  const unavailable=selected.filter(room=>room.occupancyStatus==="OCCUPIED"||room.reservations.length||room.tasks.length);
  if(unavailable.length)return res.status(409).json({error:"Cannot archive rooms with an active stay, upcoming reservation or unfinished housekeeping task: "+unavailable.map(room=>room.number).join(", ")+". Complete or move those operations first."});
  await prisma.room.updateMany({where:{id:{in:roomIds},archivedAt:null},data:{archivedAt:new Date()}});
  res.json({success:true,archived:roomIds.length,message:roomIds.length+" room(s) archived. Their history has been preserved."});
}));
app.patch("/api/rooms/:id/restore", allow("rooms.update"), requireBranchContext, asyncRoute(async (req,res) => {
  const room=await prisma.room.findFirst({where:{id:req.params.id,...branchScope(req)}});
  if(!room)return res.status(404).json({error:"Room not found"});
  if(!room.archivedAt)return res.status(409).json({error:"This room is already active"});
  const restored=await prisma.room.update({where:{id:room.id},data:{archivedAt:null}});
  res.json({success:true,room:restored,message:"Room "+room.number+" restored"});
}));
app.delete("/api/rooms/:id", allow("rooms.delete"), requireBranchContext, asyncRoute(async (req,res) => {
  const room=await prisma.room.findFirst({where:{id:req.params.id,...branchScope(req)}});
  if(!room)return res.status(404).json({error:"Room not found"});
  if(room.archivedAt)return res.status(409).json({error:"This room is already archived"});
  if(room.occupancyStatus==="OCCUPIED")return res.status(409).json({error:"An occupied room cannot be archived"});
  const [activeReservations,openTasks]=await Promise.all([prisma.reservation.count({where:{roomId:room.id,status:{in:["PENDING","CONFIRMED","CHECKED_IN"]}}}),prisma.housekeepingTask.count({where:{roomId:room.id,status:{not:"COMPLETED"}}})]);
  if(activeReservations||openTasks)return res.status(409).json({error:"This room has active reservations or unfinished housekeeping tasks and cannot be archived"});
  const archived=await prisma.room.update({where:{id:room.id},data:{archivedAt:new Date()}});
  res.json({success:true,room:archived,message:"Room archived. Its history has been preserved."});
}));
app.patch("/api/rooms/:id/out-of-order", allow("rooms.update"), requireBranchContext, asyncRoute(async (req,res) => {
  const room=await prisma.room.findFirst({where:{id:req.params.id,...branchScope(req)}});
  if(!room||room.archivedAt)return res.status(404).json({error:"Active room not found"});
  const outOfOrder=Boolean(req.body.outOfOrder);
  if(outOfOrder){
    if(room.occupancyStatus==="OCCUPIED")return res.status(409).json({error:"An occupied room cannot be marked out of order"});
    const activeReservations=await prisma.reservation.count({where:{roomId:room.id,status:{in:["PENDING","CONFIRMED","CHECKED_IN"]}}});
    if(activeReservations)return res.status(409).json({error:"This room has active or pending reservations. Move or resolve them before marking it out of order."});
  }
  const updated=await prisma.room.update({where:{id:room.id},data:{occupancyStatus:outOfOrder?"OUT_OF_ORDER":"AVAILABLE"}});
  res.json({success:true,room:updated,message:outOfOrder?"Room marked out of order":"Room returned to service"});
}));

app.patch("/api/rooms/:id", allow("rooms.update"), requireBranchContext, asyncRoute(async (req,res) => {
  const allowed = ["floor","category","rate","notes"];
  const data = Object.fromEntries(Object.entries(req.body).filter(([key])=>allowed.includes(key)));
  res.json(await prisma.room.update({where:{id:req.params.id},data}));
}));

app.get("/api/reservations", allow("reservations.view"), asyncRoute(async (req,res) => {
  const where = {...branchScope(req)};
  if (req.query.status) where.status = req.query.status;
  if (req.query.source) where.source = req.query.source;
  if (req.query.date) { const d=dayStart(req.query.date); where.checkIn={gte:d,lt:dayEnd(d)}; }
  res.json(await prisma.reservation.findMany({where,include:{guest:true,room:true,payments:true,statusHistory:{orderBy:{changedAt:"asc"}}},orderBy:{createdAt:"desc"}}));
}));
app.post("/api/reservations", allow("reservations.create"), requireBranchContext, asyncRoute(async (req,res) => {
  const {guestId,roomId,checkIn,checkOut,totalAmount,adults,children,source,notes} = req.body;
  if (!guestId||!roomId||!checkIn) return res.status(400).json({error:"Guest, room and check-in are required"});
  const bookingSource=source||"WALK_IN";
  if(bookingSource!=="WALK_IN"&&!checkOut) return res.status(400).json({error:"Check-out is required for advance reservations"});
  if(totalAmount!==undefined&&totalAmount!==null&&totalAmount!==""&&(!Number.isFinite(Number(totalAmount))||Number(totalAmount)<0)) return res.status(400).json({error:"Total amount must be a valid non-negative number"});
  const start=new Date(checkIn);
  if(!Number.isFinite(start.getTime())) return res.status(400).json({error:"Choose a valid check-in date"});
  const end=checkOut?new Date(checkOut):null;
  if(checkOut&&(!Number.isFinite(end.getTime())||!(end>start))) return res.status(400).json({error:"Check-out must be after check-in"});
  const room=await prisma.room.findFirst({where:{id:roomId,...branchScope(req)}});
  if(!room) return res.status(404).json({error:"Room not found"});
  if(room.archivedAt) return res.status(409).json({error:"Archived rooms cannot be used for bookings or housekeeping"});
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
  const reservation=await prisma.reservation.create({data:{bookingCode,guestId,roomId,branchId:req.branchId,checkIn:start,checkOut:end,totalAmount:totalAmount===""||totalAmount==null?null:Number(totalAmount),adults:adults===""||adults==null?1:Number(adults),children:children===""||children==null?0:Number(children),source:bookingSource,notes,status:isWalkIn?"CHECKED_IN":"CONFIRMED",checkedInAt:isWalkIn?new Date():null},include:{guest:true,room:true}});
  await prisma.reservationStatusHistory.create({data:{reservationId:reservation.id,fromStatus:null,toStatus:reservation.status,changedBy:req.user.fullName||req.user.email||"Staff"}});
  if(isWalkIn) await prisma.room.update({where:{id:roomId},data:{occupancyStatus:"OCCUPIED",housekeepingStatus:"CLEAN"}});
  res.status(201).json(reservation);
}));
app.patch("/api/reservations/:id/status", requireBranchContext, (req,res,next)=>{
 const permission=({CONFIRMED:"reservations.confirm",CANCELLED:"reservations.cancel",CHECKED_IN:"reservations.checkIn",CHECKED_OUT:"reservations.checkOut",NO_SHOW:"reservations.update"})[req.body.status]||"reservations.update";
 return allow(permission)(req,res,next);
}, asyncRoute(async (req,res) => {
  const {status,totalAmount,extraCharges,discount}=req.body;
  const current=await prisma.reservation.findFirst({where:{id:req.params.id,...branchScope(req)},include:{room:true,guest:{select:{guestAccountId:true}}}});
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
  if(current.guest?.guestAccountId)io.to("guest:"+current.guest.guestAccountId).emit("reservation:updated",{bookingCode:updated.bookingCode,status:updated.status});
  res.json(updated);
}));

app.get("/api/guests", allow("guests.view"), asyncRoute(async (req,res)=>{const records=await prisma.guest.findMany({where:{organizationId:req.organizationId},orderBy:{createdAt:"desc"}});const seenAccounts=new Set();res.json(records.filter(guest=>{if(!guest.guestAccountId)return true;if(seenAccounts.has(guest.guestAccountId))return false;seenAccounts.add(guest.guestAccountId);return true;}));}));
app.post("/api/guests", allow("guests.create"), asyncRoute(async (req,res)=>{
  const {fullName,email,idType,idNumber}=req.body;
  const phone=normalizePhone(req.body.phone);
  if(!fullName||!isValidIndianMobile(phone)) return res.status(400).json({error:"Enter a guest name and a valid 10-digit Indian mobile number starting with 6, 7, 8 or 9"});
  res.status(201).json(await prisma.guest.create({data:{organizationId:req.organizationId,fullName,phone,email,idType,idNumber}}));
}));

app.get("/api/housekeeping/assignees",allow("housekeeping.tasks.assign"),asyncRoute(async(_req,res)=>{const users=await prisma.user.findMany({where:{active:true},select:{id:true,fullName:true,role:true,active:true,roleRecord:{select:{name:true,permissions:true}}},orderBy:{fullName:"asc"}});res.json(users.filter(user=>Array.isArray(user.roleRecord?.permissions)&&user.roleRecord.permissions.includes("housekeeping.tasks.viewAssigned")));}));

app.get("/api/housekeeping", (req,res,next)=>{
 const permissions=req.user?.permissions||[];
 if(req.user?.role==="ADMIN"||permissions.includes("*")||permissions.includes("housekeeping.tasks.viewAll"))return next();
 if(permissions.includes("housekeeping.tasks.viewAssigned")){req.housekeepingAssignedOnly=true;return next();}
 return res.status(403).json({error:"Your role does not have permission to view housekeeping tasks"});
}, asyncRoute(async (req,res)=>{
 const where={...(req.housekeepingAssignedOnly?{assignedTo:req.user.fullName}:{}),room:branchScope(req)};
 if(req.query.status)where.status=req.query.status;
 if(req.query.date){const d=dayStart(req.query.date);where.scheduledAt={gte:d,lt:dayEnd(d)};}
 res.json(await prisma.housekeepingTask.findMany({where,include:{room:true},orderBy:{scheduledAt:"desc"}}));
}));
app.post("/api/housekeeping", allow("housekeeping.tasks.create"), requireBranchContext, asyncRoute(async (req,res)=>{
  const {roomId,description,assignedTo,scheduledAt,taskType}=req.body;
  if(!roomId) return res.status(400).json({error:"Choose a room for this task"});
  const room=await prisma.room.findUnique({where:{id:roomId}});
  if(!room) return res.status(404).json({error:"Room not found"});
  if(room.archivedAt) return res.status(409).json({error:"Archived rooms cannot be used for bookings or housekeeping"});
  const scheduled=scheduledAt?new Date(scheduledAt):new Date();
  if(Number.isNaN(scheduled.getTime())) return res.status(400).json({error:"Enter a valid scheduled date and time"});
  if(assignedTo){
    const cleanerCandidates=await prisma.user.findMany({where:{fullName:assignedTo,active:true},include:{roleRecord:true}});
    const cleaner=cleanerCandidates.find(candidate=>Array.isArray(candidate.roleRecord?.permissions)&&candidate.roleRecord.permissions.includes("housekeeping.tasks.viewAssigned"));
    if(!cleaner) return res.status(400).json({error:"Choose an active housekeeping staff member"});
  }
  const result=await prisma.$transaction(async tx=>{
    const taskLabel=String(taskType||"DAILY_CLEANING").replaceAll("_"," ").toLowerCase().replace(/\b\w/g,c=>c.toUpperCase());
    const taskDescription=String(description||"").trim()||taskLabel;
    const task=await tx.housekeepingTask.create({data:{roomId,description:taskDescription,assignedTo:assignedTo||null,taskType:taskType||"DAILY_CLEANING",scheduledAt:scheduled},include:{room:true}});
    const active=await tx.housekeepingTask.count({where:{roomId,status:"IN_PROGRESS"}});
    await tx.room.update({where:{id:roomId},data:{housekeepingStatus:active?"CLEANING":"DIRTY"}});
    return {...task,room:{...task.room,housekeepingStatus:active?"CLEANING":"DIRTY"}};
  });
  res.status(201).json(result);
}));
app.post("/api/housekeeping/generate-daily", allow("housekeeping.tasks.create"), asyncRoute(async (_req,res)=>{
  const today=dayStart(), tomorrow=dayEnd();
  const occupied=await prisma.room.findMany({where:{occupancyStatus:"OCCUPIED"}});
  let created=0;
  for(const room of occupied){
    const existing=await prisma.housekeepingTask.findFirst({where:{roomId:room.id,taskType:"DAILY_CLEANING",scheduledAt:{gte:today,lt:tomorrow}}});
    if(!existing){await prisma.housekeepingTask.create({data:{roomId:room.id,taskType:"DAILY_CLEANING",description:"Daily occupied-room cleaning"}});created++;}
  }
  res.json({created,message:`Created ${created} daily cleaning tasks`});
}));
app.patch("/api/housekeeping/:id/assign", allow("housekeeping.tasks.assign"), requireBranchContext, asyncRoute(async (req,res)=>{
  const {assignedTo}=req.body;
  const task=await prisma.housekeepingTask.findUnique({where:{id:req.params.id}});
  if(!task) return res.status(404).json({error:"Housekeeping task not found"});
  if(task.status!=="PENDING") return res.status(409).json({error:"Only pending tasks can be reassigned"});
  if(assignedTo){
    const cleanerCandidates=await prisma.user.findMany({where:{fullName:assignedTo,active:true},include:{roleRecord:true}});
    const cleaner=cleanerCandidates.find(candidate=>Array.isArray(candidate.roleRecord?.permissions)&&candidate.roleRecord.permissions.includes("housekeeping.tasks.viewAssigned"));
    if(!cleaner) return res.status(400).json({error:"Choose an active housekeeping staff member"});
  }
  res.json(await prisma.housekeepingTask.update({where:{id:task.id},data:{assignedTo:assignedTo||null},include:{room:true}}));
}));

app.patch("/api/housekeeping/:id/status", requireBranchContext, (req,res,next)=>allow(req.body.status==="COMPLETED"?"housekeeping.tasks.complete":"housekeeping.tasks.start")(req,res,next), asyncRoute(async (req,res)=>{
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

app.get("/api/payments", allow("payments.view"), asyncRoute(async (req,res)=>res.json(await prisma.payment.findMany({where:branchScope(req),include:{guest:true,reservation:true},orderBy:{paidAt:"desc"}}))));
app.post("/api/payments", allow("payments.record"), requireBranchContext, asyncRoute(async (req,res)=>{
  const {guestId,reservationId,amount,method,reference}=req.body;
  if(!guestId||amount==null||!["CASH","UPI","CARD","ONLINE"].includes(method)) return res.status(400).json({error:"Guest, amount and valid payment method are required"});
  res.status(201).json(await prisma.payment.create({data:{paymentCode:"PAY"+Date.now().toString().slice(-8),guestId,reservationId:reservationId||null,branchId:req.branchId,amount,method,reference},include:{guest:true}}));
}));

app.get("/api/room-rack", allow("rooms.view"), asyncRoute(async (req,res)=>{
  const mode=["daily","weekly","monthly"].includes(req.query.mode)?req.query.mode:"daily";
  const start=dayStart(req.query.date||new Date());
  if(mode==="weekly")start.setDate(start.getDate()-((start.getDay()+6)%7));
  if(mode==="monthly")start.setDate(1);
  const days=mode==="daily"?1:mode==="weekly"?7:new Date(start.getFullYear(),start.getMonth()+1,0).getDate();
  const end=new Date(start);end.setDate(end.getDate()+days);
  const [rooms,reservations]=await Promise.all([
    prisma.room.findMany({where:{...branchScope(req),archivedAt:null},orderBy:[{floor:"asc"},{number:"asc"}]}),
    prisma.reservation.findMany({where:{...branchScope(req),checkIn:{lt:end},OR:[{checkOut:{gt:start}},{checkOut:null}],status:{in:["CONFIRMED","CHECKED_IN"]}},include:{guest:true}})
  ]);
  const dates=Array.from({length:days},(_,i)=>{const d=new Date(start);d.setDate(d.getDate()+i);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,"0"),String(d.getDate()).padStart(2,"0")].join("-");});
  res.json({mode,dates,rooms:rooms.map(room=>({...room,reservations:reservations.filter(r=>r.roomId===room.id)}))});
}));

app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:err.code==="P2002"?"That record already exists": "Server error. Check the server logs."});});
app.get("/api/staff",allow("staff.view"),asyncRoute(async(_req,res)=>res.json(await prisma.user.findMany({select:{id:true,fullName:true,email:true,role:true,roleId:true,roleRecord:{select:{name:true,permissions:true}},active:true,createdAt:true},orderBy:{createdAt:"desc"}}))));
app.post("/api/staff",allow("staff.create"),allow("roles.assign"),asyncRoute(async(req,res)=>{
 const {fullName,email,password,roleId}=req.body;
 if(!fullName||!email||!password||!roleId)return res.status(400).json({error:"Name, email, password and role are required"});
 const selectedRole=await prisma.role.findUnique({where:{id:roleId}});
 if(!selectedRole)return res.status(400).json({error:"Choose a valid role"});
 const passwordHash=await bcrypt.hash(password,12);
 const user=await prisma.user.create({data:{fullName,email:String(email).toLowerCase(),passwordHash,role:selectedRole.key,roleId:selectedRole.id},select:{id:true,fullName:true,email:true,role:true,roleId:true,active:true}});
 res.status(201).json(user);
}));
app.patch("/api/staff/:id/active",allow("staff.deactivate"),asyncRoute(async(req,res)=>{if(req.params.id===req.user.id&&req.body.active===false)return res.status(400).json({error:"You cannot deactivate your own account"});res.json(await prisma.user.update({where:{id:req.params.id},data:{active:Boolean(req.body.active)},select:{id:true,fullName:true,email:true,role:true,active:true}}));}));

app.get("/api/roles",allow("roles.view"),asyncRoute(async(_req,res)=>res.json(await prisma.role.findMany({orderBy:[{isSystem:"desc"},{name:"asc"}]}))));
app.post("/api/roles",allow("roles.create"),asyncRoute(async(req,res)=>{
 const name=String(req.body.name||"").trim(),permissions=Array.isArray(req.body.permissions)?[...new Set(req.body.permissions.filter(p=>typeof p==="string"))]:[];
 if(!name)return res.status(400).json({error:"Role name is required"});
 const key="CUSTOM_"+name.toUpperCase().replace(/[^A-Z0-9]+/g,"_").replace(/^_|_$/g,"")+"_"+Date.now().toString(36).toUpperCase();
 res.status(201).json(await prisma.role.create({data:{key,name,description:String(req.body.description||"").trim()||null,permissions,isSystem:false}}));
}));
app.patch("/api/roles/:id",allow("roles.update"),asyncRoute(async(req,res)=>{
 const current=await prisma.role.findUnique({where:{id:req.params.id}});if(!current)return res.status(404).json({error:"Role not found"});
 const data={};
 if(req.body.name!==undefined){const name=String(req.body.name).trim();if(!name)return res.status(400).json({error:"Role name cannot be empty"});data.name=name;}
 if(req.body.description!==undefined)data.description=String(req.body.description||"").trim()||null;
 if(req.body.permissions!==undefined){if(!Array.isArray(req.body.permissions)||req.body.permissions.some(p=>typeof p!=="string"))return res.status(400).json({error:"Permissions must be a list"});data.permissions=[...new Set(req.body.permissions)];}
 res.json(await prisma.role.update({where:{id:current.id},data}));
}));
app.delete("/api/roles/:id",allow("roles.update"),asyncRoute(async(req,res)=>{
 const role=await prisma.role.findUnique({where:{id:req.params.id},include:{users:{select:{id:true},take:1}}});
 if(!role)return res.status(404).json({error:"Role not found"});
 if(role.isSystem)return res.status(400).json({error:"Predefined roles cannot be deleted"});
 if(role.users.length)return res.status(409).json({error:"Reassign users before deleting this role"});
 await prisma.role.delete({where:{id:role.id}});res.json({success:true});
}));

httpServer.listen(port,()=>console.log("EzyStay API running on http://localhost:"+port));