import React,{useEffect,useMemo,useRef,useState} from "react";
import {CalendarDays,ChevronLeft,ChevronRight} from "lucide-react";

const pad=n=>String(n).padStart(2,"0");
const keyOf=d=>d?d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate()):"";
const parseKey=value=>{if(!value)return null;const [y,m,d]=String(value).slice(0,10).split("-").map(Number);return new Date(y,m-1,d)};
const monthLabel=d=>d.toLocaleDateString("en-IN",{month:"long",year:"numeric"});
const displayDate=value=>{const d=parseKey(value);return d?d.toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"}):""};

export default function DatePicker({value="",onChange,min="",placeholder="Pick a date",className="",disabled=false,required=false,ariaLabel="Choose date",id}) {
 const [open,setOpen]=useState(false);
 const [visible,setVisible]=useState(()=>parseKey(value)||parseKey(min)||new Date());
 const root=useRef(null);
 const selected=parseKey(value), minimum=parseKey(min);
 useEffect(()=>{if(value){const next=parseKey(value);if(next)setVisible(next)}},[value]);
 useEffect(()=>{if(!open)return;const outside=e=>{if(!root.current?.contains(e.target))setOpen(false)};const escape=e=>{if(e.key==="Escape")setOpen(false)};document.addEventListener("mousedown",outside);document.addEventListener("keydown",escape);return()=>{document.removeEventListener("mousedown",outside);document.removeEventListener("keydown",escape)}},[open]);
 const days=useMemo(()=>{const first=new Date(visible.getFullYear(),visible.getMonth(),1);const start=new Date(first);start.setDate(1-first.getDay());return Array.from({length:42},(_,i)=>{const d=new Date(start);d.setDate(start.getDate()+i);return d})},[visible]);
 const changeMonth=amount=>setVisible(d=>new Date(d.getFullYear(),d.getMonth()+amount,1));
 function choose(day){if(minimum&&day<new Date(minimum.getFullYear(),minimum.getMonth(),minimum.getDate()))return;onChange?.(keyOf(day));setOpen(false)}
 return <div className={"ez-date-picker "+className} ref={root}>
  <button id={id} type="button" className="ez-date-trigger" disabled={disabled} aria-label={ariaLabel} aria-haspopup="dialog" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>
   <span className={value?"":"is-empty"}>{value?displayDate(value):placeholder}</span><CalendarDays size={16}/>
  </button>
  {open&&<div className="ez-calendar-popover" role="dialog" aria-label="Choose a date">
   <div className="ez-calendar-head"><button type="button" aria-label="Previous month" onClick={()=>changeMonth(-1)}><ChevronLeft size={17}/></button><strong>{monthLabel(visible)}</strong><button type="button" aria-label="Next month" onClick={()=>changeMonth(1)}><ChevronRight size={17}/></button></div>
   <div className="ez-calendar-grid ez-calendar-weekdays">{["Su","Mo","Tu","We","Th","Fr","Sa"].map(d=><span key={d}>{d}</span>)}</div>
   <div className="ez-calendar-grid">{days.map((day,i)=>{const dayKey=keyOf(day),outside=day.getMonth()!==visible.getMonth(),isSelected=dayKey===value,isToday=dayKey===keyOf(new Date()),tooEarly=minimum&&day<new Date(minimum.getFullYear(),minimum.getMonth(),minimum.getDate());return <button type="button" key={i} disabled={!!tooEarly} className={["ez-calendar-day",outside?"outside":"",isSelected?"selected":"",isToday?"today":""].filter(Boolean).join(" ")} onClick={()=>choose(day)}>{day.getDate()}</button>})}</div>
   <div className="ez-calendar-footer"><button type="button" onClick={()=>choose(new Date())} disabled={!!(minimum&&new Date()<new Date(minimum.getFullYear(),minimum.getMonth(),minimum.getDate()))}>Today</button>{value&&<button type="button" onClick={()=>{onChange?.("");setOpen(false)}}>Clear</button>}</div>
  </div>}
  {required&&<input className="ez-date-required" tabIndex={-1} aria-hidden="true" required value={value} onChange={()=>{}}/>}
 </div>
}
