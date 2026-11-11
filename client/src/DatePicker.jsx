import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {CalendarDays,ChevronLeft,ChevronRight} from "lucide-react";

const pad=n=>String(n).padStart(2,"0");
const keyOf=d=>d?d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate()):"";
const parseKey=value=>{if(!value)return null;const [y,m,d]=String(value).slice(0,10).split("-").map(Number);return new Date(y,m-1,d)};
const monthLabel=d=>d.toLocaleDateString("en-IN",{month:"long",year:"numeric"});
const displayDate=value=>{const d=parseKey(value);return d?d.toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"}):""};

export default function DatePicker({value="",onChange,min="",placeholder="Pick a date",className="",disabled=false,required=false,ariaLabel="Choose date",id}) {
 const [open,setOpen]=useState(false);
 const [visible,setVisible]=useState(()=>parseKey(value)||parseKey(min)||new Date());
 const [popoverStyle,setPopoverStyle]=useState(null);
 const root=useRef(null);
 const popover=useRef(null);
 const selected=parseKey(value), minimum=parseKey(min);
 useEffect(()=>{if(value){const next=parseKey(value);if(next)setVisible(next)}},[value]);

 // Render the popup in the document layer so forms, modals and cards cannot clip it.
 // Keep it anchored to the trigger and choose the side with the most usable space.
 useLayoutEffect(()=>{
  if(!open)return;
  const place=()=>{
   const anchor=root.current?.getBoundingClientRect();
   const panel=popover.current;
   if(!anchor||!panel)return;
   const margin=12,gap=6;
   const width=Math.min(264,window.innerWidth-margin*2);
   const height=panel.getBoundingClientRect().height;
   const below=window.innerHeight-anchor.bottom-margin-gap;
   const above=anchor.top-margin-gap;
   const top=below>=height||below>=above?anchor.bottom+gap:Math.max(margin,anchor.top-gap-height);
   const left=Math.max(margin,Math.min(anchor.left,window.innerWidth-width-margin));
   setPopoverStyle({position:"fixed",top,left,width,visibility:"visible"});
  };
  place();
  window.addEventListener("resize",place);
  window.addEventListener("scroll",place,true);
  return()=>{window.removeEventListener("resize",place);window.removeEventListener("scroll",place,true)};
 },[open]);

 useEffect(()=>{
  if(!open)return;
  const outside=e=>{if(!root.current?.contains(e.target)&&!popover.current?.contains(e.target))setOpen(false)};
  const escape=e=>{if(e.key==="Escape")setOpen(false)};
  document.addEventListener("mousedown",outside);
  document.addEventListener("keydown",escape);
  return()=>{document.removeEventListener("mousedown",outside);document.removeEventListener("keydown",escape)};
 },[open]);

 const days=useMemo(()=>{const first=new Date(visible.getFullYear(),visible.getMonth(),1);const start=new Date(first);start.setDate(1-first.getDay());return Array.from({length:42},(_,i)=>{const d=new Date(start);d.setDate(start.getDate()+i);return d})},[visible]);
 const changeMonth=amount=>setVisible(d=>new Date(d.getFullYear(),d.getMonth()+amount,1));
 function choose(day){if(minimum&&day<new Date(minimum.getFullYear(),minimum.getMonth(),minimum.getDate()))return;onChange?.(keyOf(day));setOpen(false)}
 const calendar=open&&createPortal(<div ref={popover} className="ez-calendar-popover" style={popoverStyle||{position:"fixed",visibility:"hidden",width:264}} role="dialog" aria-label="Choose a date">
  <div className="ez-calendar-head"><button type="button" aria-label="Previous month" onClick={()=>changeMonth(-1)}><ChevronLeft size={16}/></button><strong>{monthLabel(visible)}</strong><button type="button" aria-label="Next month" onClick={()=>changeMonth(1)}><ChevronRight size={16}/></button></div>
  <div className="ez-calendar-grid ez-calendar-weekdays">{["Su","Mo","Tu","We","Th","Fr","Sa"].map(d=><span key={d}>{d}</span>)}</div>
  <div className="ez-calendar-grid">{days.map((day,i)=>{const dayKey=keyOf(day),outside=day.getMonth()!==visible.getMonth(),isSelected=dayKey===value,isToday=dayKey===keyOf(new Date()),tooEarly=minimum&&day<new Date(minimum.getFullYear(),minimum.getMonth(),minimum.getDate());return <button type="button" key={i} disabled={!!tooEarly} className={["ez-calendar-day",outside?"outside":"",isSelected?"selected":"",isToday?"today":""].filter(Boolean).join(" ")} onClick={()=>choose(day)}>{day.getDate()}</button>})}</div>
  <div className="ez-calendar-footer"><button type="button" onClick={()=>choose(new Date())} disabled={!!(minimum&&new Date()<new Date(minimum.getFullYear(),minimum.getMonth(),minimum.getDate()))}>Today</button>{value&&<button type="button" onClick={()=>{onChange?.("");setOpen(false)}}>Clear</button>}</div>
 </div>,document.body);
 return <div className={"ez-date-picker "+className} ref={root}>
  <button id={id} type="button" className="ez-date-trigger" disabled={disabled} aria-label={ariaLabel} aria-haspopup="dialog" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>
   <span className={value?"":"is-empty"}>{value?displayDate(value):placeholder}</span><CalendarDays size={16}/>
  </button>
  {calendar}
  {required&&<input className="ez-date-required" tabIndex={-1} aria-hidden="true" required value={value} onChange={()=>{}}/>}
 </div>
}
