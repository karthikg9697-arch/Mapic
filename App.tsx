
import React, { useEffect, useRef, useState, useCallback } from "react";
import { GeoPoint, Trip, DraftTrip } from "./types";
import { haversineMeters, metersToKm, formatTimeHMS } from "./utils/geo";
import { generatePosterPng } from "./utils/canvas";
import { generateTripInsight } from "./services/geminiService";

const TRIPS_KEY = "todayroute_trips_v7";
const DRAFT_KEY = "todayroute_draft_trip";

const uid = () => "TR-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);

const loadTrips = (): Trip[] => {
  try {
    const raw = localStorage.getItem(TRIPS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
};

const saveTrips = (trips: Trip[]) => {
  localStorage.setItem(TRIPS_KEY, JSON.stringify(trips.slice(0, 50)));
};

const formatDate = (d = new Date()) => 
  d.toLocaleDateString("en-US", { day: "2-digit", month: "long", year: "numeric" });

const formatTimeShort = (d: Date) => {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
};

async function reverseGeocode(lat: number, lng: number): Promise<string> {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`, {
      headers: { 'Accept-Language': 'en' }
    });
    const data = await res.json();
    if (!data || !data.address) return "";
    const addr = data.address;
    const road = addr.road || addr.neighbourhood || addr.suburb || "";
    const area = addr.city || addr.town || addr.village || addr.county || "";
    if (road && area) return `${road}, ${area}`;
    return road || area || "";
  } catch (err) {
    console.error("Geocoding error:", err);
    return "";
  }
}

const App: React.FC = () => {
  const [trips, setTrips] = useState<Trip[]>(() => loadTrips());
  const [isTracking, setIsTracking] = useState(false);
  const [isPrivate, setIsPrivate] = useState(false);
  const [gpsStatus, setGpsStatus] = useState<string>("Idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  
  const [distanceMeters, setDistanceMeters] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [startedAt, setStartedAt] = useState<Date | null>(null);
  const [startTimeLabel, setStartTimeLabel] = useState<string>("");

  const [activeTrip, setActiveTrip] = useState<Trip | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  
  const [finishScreen, setFinishScreen] = useState<{
    show: boolean;
    startLabel: string;
    endLabel: string;
    points: GeoPoint[];
    dist: number;
    time: number;
    start: Date;
    startTimeStr: string;
    endTimeStr: string;
  } | null>(null);

  const watchIdRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPointRef = useRef<GeoPoint | null>(null);
  const pointsRef = useRef<GeoPoint[]>([]);

  useEffect(() => saveTrips(trips), [trips]);

  useEffect(() => {
    const draft = localStorage.getItem(DRAFT_KEY);
    if (draft) setHasDraft(true);
  }, []);

  const stopTracking = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (timerRef.current) clearInterval(timerRef.current);
    localStorage.removeItem(DRAFT_KEY);
    setIsTracking(false);
    setGpsStatus("Idle");
  }, []);

  const addPoint = useCallback((p: GeoPoint) => {
    if (p.acc && p.acc > 150) {
      setGpsStatus("Weak GPS ⚠️");
      return; 
    }
    setGpsStatus("Good GPS ✅");
    const last = lastPointRef.current;
    if (last) {
      const d = haversineMeters(last, p);
      if (d < 1) return; 
      setDistanceMeters((prev) => prev + d);
    }
    lastPointRef.current = p;
    pointsRef.current.push(p);
  }, []);

  const startTracking = (resumingDraft?: DraftTrip) => {
    if (!navigator.geolocation) return alert("GPS not supported.");

    if (resumingDraft) {
      pointsRef.current = resumingDraft.points;
      lastPointRef.current = resumingDraft.points[resumingDraft.points.length - 1] || null;
      setDistanceMeters(resumingDraft.distanceMeters);
      setElapsedSec(resumingDraft.elapsedSec);
      setStartedAt(new Date(resumingDraft.startedAt));
      setStartTimeLabel(resumingDraft.startTime || formatTimeShort(new Date(resumingDraft.startedAt)));
      setIsPrivate(resumingDraft.isPrivate);
    } else {
      const now = new Date();
      pointsRef.current = [];
      lastPointRef.current = null;
      setDistanceMeters(0);
      setElapsedSec(0);
      setStartedAt(now);
      setStartTimeLabel(formatTimeShort(now));
    }

    setIsTracking(true);
    setGpsStatus("Searching...");
    timerRef.current = setInterval(() => setElapsedSec(s => s + 1), 1000);

    const geoOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 };
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => addPoint({ lat: pos.coords.latitude, lng: pos.coords.longitude, t: Date.now(), acc: pos.coords.accuracy }),
      (err) => {
        if (err.code === 1) setErrorMessage("GPS Permission Denied");
        else setGpsStatus("GPS Error ⚠️");
      },
      geoOptions
    );
  };

  useEffect(() => {
    if (!isTracking) return;
    const interval = setInterval(() => {
      const draft: DraftTrip = {
        startedAt: startedAt?.toISOString() || new Date().toISOString(),
        startTime: startTimeLabel,
        isPrivate,
        elapsedSec,
        distanceMeters,
        points: pointsRef.current
      };
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    }, 10000);
    return () => clearInterval(interval);
  }, [isTracking, elapsedSec, distanceMeters, startedAt, startTimeLabel, isPrivate]);

  const handleResume = () => {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return setHasDraft(false);
    try {
      const draft: DraftTrip = JSON.parse(raw);
      setHasDraft(false);
      startTracking(draft);
    } catch {
      localStorage.removeItem(DRAFT_KEY);
      setHasDraft(false);
    }
  };

  const handleDiscard = () => {
    localStorage.removeItem(DRAFT_KEY);
    setHasDraft(false);
  };

  const handleFinish = async () => {
    if (pointsRef.current.length < 2) {
      if (!confirm("No movement detected. Stop anyway?")) return;
    }
    setIsSaving(true);
    const snapPoints = [...pointsRef.current];
    const snapDist = distanceMeters;
    const snapTime = elapsedSec;
    const snapStart = startedAt || new Date();
    const snapEndTime = new Date();
    
    stopTracking();

    let startLoc = "Start";
    let endLoc = "End";

    if (!isPrivate) {
      const [sRes, eRes] = await Promise.all([
        reverseGeocode(snapPoints[0].lat, snapPoints[0].lng),
        reverseGeocode(snapPoints[snapPoints.length - 1].lat, snapPoints[snapPoints.length - 1].lng)
      ]);
      startLoc = sRes || "Start";
      endLoc = eRes || "End";
    }

    setIsSaving(false);
    setFinishScreen({
      show: true,
      startLabel: startLoc,
      endLabel: endLoc,
      points: snapPoints,
      dist: snapDist,
      time: snapTime,
      start: snapStart,
      startTimeStr: startTimeLabel,
      endTimeStr: formatTimeShort(snapEndTime)
    });
  };

  const handleFinalSave = async () => {
    if (!finishScreen) return;
    setIsSaving(true);
    const { startLabel, endLabel, points, dist, time, start, startTimeStr, endTimeStr } = finishScreen;
    
    // Simplified static title for MVP
    const tripName = "ACTIVITY";

    try {
      const insight = await generateTripInsight(dist, time, tripName);
      const timeRange = `${startTimeStr} – ${endTimeStr}`;
      
      const poster = generatePosterPng({
        title: tripName,
        dateLabel: formatDate(start),
        timeRange,
        distanceMeters: dist,
        durationSec: time,
        points: points,
        startLabel,
        endLabel
      });

      const newTrip: Trip = {
        id: uid(),
        name: tripName,
        date: start.toISOString(),
        startTime: startTimeStr,
        endTime: endTimeStr,
        isPrivate,
        distanceMeters: dist,
        durationSec: time,
        points: points,
        posterPngBase64: poster,
        aiInsight: insight,
        startLabel,
        endLabel
      };

      setTrips(prev => [newTrip, ...prev]);
      setActiveTrip(newTrip);
      setFinishScreen(null);
    } catch (e) {
      alert("Poster failed to generate, but trip is saved.");
    } finally {
      setIsSaving(false);
    }
  };

  const forceRegenerate = async (trip: Trip) => {
    setIsSaving(true);
    try {
      const timeRange = trip.startTime && trip.endTime ? `${trip.startTime} – ${trip.endTime}` : undefined;
      const poster = generatePosterPng({
        title: trip.name,
        dateLabel: formatDate(new Date(trip.date)),
        timeRange,
        distanceMeters: trip.distanceMeters,
        durationSec: trip.durationSec,
        points: trip.points,
        startLabel: trip.startLabel || "Start",
        endLabel: trip.endLabel || "End"
      });
      const updated = { ...trip, posterPngBase64: poster };
      setTrips(prev => prev.map(t => t.id === trip.id ? updated : t));
      setActiveTrip(updated);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="max-w-md mx-auto min-h-screen bg-slate-50 flex flex-col font-sans selection:bg-indigo-100">
      <header className="p-8 pb-4 flex justify-between items-start">
        <div>
          <h1 className="text-4xl font-black text-slate-900 tracking-tighter">TodayRoute</h1>
          <p className="text-slate-400 font-bold uppercase text-[10px] tracking-[0.2em] mt-2">{formatDate()}</p>
        </div>
        {!isTracking && !finishScreen && (
          <button 
            onClick={() => setIsPrivate(!isPrivate)}
            className={`px-4 py-2 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all border ${
              isPrivate ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-400 border-slate-200'
            }`}
          >
            {isPrivate ? '🔒 Private' : '🌍 Public'}
          </button>
        )}
      </header>

      {hasDraft && !isTracking && !finishScreen && (
        <div className="mx-6 mb-6 p-6 bg-indigo-600 rounded-[2.5rem] shadow-xl text-white flex flex-col gap-4 animate-in fade-in slide-in-from-top duration-500">
          <div>
            <p className="font-black text-sm uppercase tracking-tight">Active trip found</p>
            <p className="text-[10px] font-bold opacity-75 uppercase tracking-widest">Resume your tracking?</p>
          </div>
          <div className="flex gap-3">
            <button onClick={handleResume} className="flex-1 bg-white text-indigo-600 py-3 rounded-2xl text-xs font-black uppercase tracking-widest active:scale-95 transition-transform">Resume</button>
            <button onClick={handleDiscard} className="flex-1 bg-indigo-500 text-white py-3 rounded-2xl text-xs font-black uppercase tracking-widest active:scale-95 transition-transform">Discard</button>
          </div>
        </div>
      )}

      <main className="px-6 flex-1 space-y-6 pb-24">
        <div className="bg-white rounded-[3rem] shadow-2xl shadow-slate-200/50 p-8 border border-slate-100 overflow-hidden relative">
          {!finishScreen ? (
            <>
              <div className="flex justify-between items-center mb-10">
                <div className={`px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest flex items-center gap-2 ${
                  gpsStatus.includes('Good') ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'
                }`}>
                  <div className={`w-1.5 h-1.5 rounded-full ${gpsStatus.includes('Good') ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                  {gpsStatus}
                </div>
                {isTracking && (
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 bg-red-500 rounded-full animate-ping"></div>
                    <span className="text-[10px] font-black text-red-500 tracking-[0.2em] uppercase">Recording</span>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-10 mb-12">
                <div>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Distance</p>
                  <div className="flex items-baseline gap-1">
                    <span className="text-6xl font-black text-slate-900 tracking-tighter leading-none">{metersToKm(distanceMeters)}</span>
                    <span className="text-xl font-bold text-slate-300">km</span>
                  </div>
                </div>
                <div>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Duration</p>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-black text-slate-900 tracking-tight">{formatTimeHMS(elapsedSec)}</span>
                  </div>
                </div>
              </div>

              {!isTracking ? (
                <button onClick={() => startTracking()} className="w-full bg-indigo-600 hover:bg-indigo-700 active:scale-[0.98] text-white font-black py-6 rounded-[2rem] shadow-2xl shadow-indigo-100 transition-all text-lg tracking-tight">
                  START RECORDING
                </button>
              ) : (
                <div className="space-y-4">
                  <button disabled={isSaving} onClick={handleFinish} className="w-full bg-slate-900 hover:bg-black active:scale-[0.98] text-white font-black py-6 rounded-[2rem] shadow-xl transition-all text-lg flex items-center justify-center gap-3">
                    {isSaving ? <div className="w-6 h-6 border-4 border-white/20 border-t-white rounded-full animate-spin" /> : "STOP & FINISH"}
                  </button>
                  <button onClick={() => { if(confirm("Discard current trip?")) stopTracking(); }} className="w-full py-2 text-slate-400 font-bold text-[10px] uppercase tracking-[0.2em] hover:text-red-500 transition-colors">Discard Trip</button>
                </div>
              )}
            </>
          ) : (
            <div className="animate-in fade-in duration-300">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-black text-slate-900">Final Summary</h2>
                <div className="px-3 py-1 bg-slate-100 rounded-full text-[9px] font-black uppercase tracking-widest">
                  {isPrivate ? '🔒 Private' : '🌍 Public'}
                </div>
              </div>
              
              <div className="p-5 bg-slate-50 rounded-3xl mb-8 flex justify-between items-center">
                 <div>
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Distance</p>
                    <p className="text-xl font-black text-slate-900">{metersToKm(finishScreen.dist)} km</p>
                 </div>
                 <div className="text-right">
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Time Range</p>
                    <p className="text-sm font-bold text-slate-600">{finishScreen.startTimeStr} – {finishScreen.endTimeStr}</p>
                 </div>
              </div>

              <div className="space-y-4 mb-8">
                <div>
                  <label className="text-[10px] font-black text-emerald-600 uppercase tracking-widest block mb-1">Start Point</label>
                  <input 
                    type="text" 
                    value={finishScreen.startLabel}
                    onChange={(e) => setFinishScreen({...finishScreen, startLabel: e.target.value})}
                    className="w-full bg-slate-100 border-none rounded-2xl px-4 py-3 text-sm font-bold text-slate-700 focus:ring-2 focus:ring-emerald-400 transition-shadow"
                    placeholder="Area name"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black text-red-500 uppercase tracking-widest block mb-1">End Point</label>
                  <input 
                    type="text" 
                    value={finishScreen.endLabel}
                    onChange={(e) => setFinishScreen({...finishScreen, endLabel: e.target.value})}
                    className="w-full bg-slate-100 border-none rounded-2xl px-4 py-3 text-sm font-bold text-slate-700 focus:ring-2 focus:ring-red-400 transition-shadow"
                    placeholder="Area name"
                  />
                </div>
              </div>

              <button 
                disabled={isSaving}
                onClick={handleFinalSave}
                className="w-full bg-indigo-600 text-white font-black py-5 rounded-3xl shadow-xl transition-all active:scale-95 flex items-center justify-center gap-3 uppercase text-sm tracking-widest"
              >
                {isSaving ? <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : "Generate Poster"}
              </button>
              <button onClick={() => setFinishScreen(null)} className="w-full py-2 mt-4 text-slate-400 font-bold text-[10px] uppercase tracking-widest hover:text-slate-600">Back to recording</button>
            </div>
          )}
        </div>

        {!finishScreen && (
          <div className="space-y-4">
            <h2 className="text-xl font-black text-slate-900 tracking-tight">Recent Paths</h2>
            <div className="flex gap-5 overflow-x-auto pb-6 no-scrollbar snap-x snap-mandatory">
              {trips.length === 0 ? (
                <div className="w-full py-16 text-center border-2 border-dashed border-slate-200 rounded-[2.5rem] flex flex-col items-center justify-center bg-white">
                  <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest">No history yet</p>
                </div>
              ) : (
                trips.map(trip => (
                  <div key={trip.id} onClick={() => setActiveTrip(trip)} className="min-w-[200px] snap-start group cursor-pointer">
                    <div className="aspect-[9/16] bg-slate-100 rounded-[2.2rem] overflow-hidden shadow-sm group-hover:shadow-xl group-hover:scale-[1.02] transition-all border border-slate-200">
                      <img src={trip.posterPngBase64} className="w-full h-full object-cover" alt={trip.name} />
                    </div>
                    <div className="mt-4 px-2">
                      <p className="text-[10px] font-black uppercase text-slate-900 truncate tracking-tight">
                        {trip.isPrivate ? '🔒 Private' : '🌍 Public'}
                      </p>
                      <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">{metersToKm(trip.distanceMeters)} km • {trip.startTime} – {trip.endTime}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </main>

      {activeTrip && (
        <div className="fixed inset-0 z-[100] bg-white flex flex-col overflow-y-auto no-scrollbar animate-in slide-in-from-bottom duration-500">
          <div className="p-6 flex justify-between items-center bg-white/95 backdrop-blur-xl sticky top-0 border-b border-slate-100 z-10">
            <button onClick={() => setActiveTrip(null)} className="p-2 hover:bg-slate-50 rounded-full transition-colors">
              <svg className="w-6 h-6 text-slate-900" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
            <span className="font-black text-sm text-slate-900 uppercase tracking-tight">Achievement</span>
            <button onClick={() => forceRegenerate(activeTrip)} className="font-black text-[10px] uppercase text-indigo-600 bg-indigo-50 px-4 py-2 rounded-full">
              Refix Map
            </button>
          </div>
          
          <div className="p-8 flex flex-col items-center gap-8 pb-32 max-w-md mx-auto w-full">
            <div className="w-full aspect-[9/16] rounded-[3rem] shadow-2xl overflow-hidden border border-slate-100 bg-slate-50 relative group">
              <img src={activeTrip.posterPngBase64} className="w-full h-full object-contain" alt="Poster" />
            </div>

            <div className="text-center flex flex-col gap-2">
              <span className="bg-emerald-50 text-emerald-700 text-[10px] font-black uppercase tracking-widest px-4 py-2 rounded-full border border-emerald-100">
                ✅ Paper Poster Mode (Fast & Private)
              </span>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">
                {activeTrip.startTime} – {activeTrip.endTime}
              </p>
            </div>

            {activeTrip.aiInsight && (
              <div className="w-full bg-slate-900 p-8 rounded-[2.5rem] shadow-xl text-white text-center italic font-medium leading-relaxed">
                "{activeTrip.aiInsight}"
              </div>
            )}
            
            <div className="w-full space-y-4">
               <button onClick={() => {
                 const link = document.createElement("a");
                 link.href = activeTrip.posterPngBase64;
                 link.download = `todayroute-${activeTrip.id}.png`;
                 link.click();
               }} className="w-full bg-indigo-600 text-white font-black py-5 rounded-2xl flex items-center justify-center gap-3 shadow-xl uppercase text-sm tracking-widest active:scale-95 transition-transform">
                 <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                 Download PNG
               </button>
               
               <button disabled className="w-full bg-slate-100 text-slate-400 font-black py-5 rounded-2xl flex items-center justify-center gap-3 uppercase text-sm tracking-widest cursor-not-allowed border border-slate-200">
                 🔒 Real Map Poster (Coming Soon)
               </button>

               <button onClick={() => { if(confirm("Permanently delete this path?")) { setTrips(prev => prev.filter(t => t.id !== activeTrip.id)); setActiveTrip(null); }}} className="w-full py-2 text-red-500 font-bold text-xs uppercase tracking-widest opacity-50 hover:opacity-100 transition-opacity">Delete History</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
