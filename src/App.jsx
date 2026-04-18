import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";

/* ─────────────────────────────────────────
   SHEETJS CDN
───────────────────────────────────────── */
let _xlsxReady = null;
function loadXLSX() {
  if (_xlsxReady) return _xlsxReady;
  _xlsxReady = new Promise((resolve, reject) => {
    if (window.XLSX) { resolve(window.XLSX); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => { _xlsxReady = null; reject(new Error("로드 실패")); };
    document.head.appendChild(s);
  });
  return _xlsxReady;
}

/* ─────────────────────────────────────────
   FONTS
───────────────────────────────────────── */
const FontLink = () => (
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
);

/* ─────────────────────────────────────────
   텍스트 파서 (카드사 앱 복사)
───────────────────────────────────────── */
const NOISE = [
  /커피값 줄이는/,/이용안내/,/다른 정보가 필요/,/혜택\s*>/,/이용내역\s*>/,
  /이용금액/,/페이지 최상단/,/^닫기$/,/본인\d{4}/,/^일시불$/,
  /^해외 신판$/,/^하이브리드$/,/실적 충족/,/분할납부/,/교통이용내역/,
  /해외청구내역/,/서비스 제공/,/받은 혜택/,/카드별 혜택/,
];
function parseTxnsText(raw) {
  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
  const dateRe = /^(\d{4}\.\d{2}\.\d{2})$/;
  const amtRe  = /^([\d,]+)\s*원$/;
  const res = []; let date = null, merchant = null, amount = null, time = "";
  const flush = cancelled => {
    if (merchant && amount !== null)
      res.push({ date, merchant, amount, time, cancelled, source:"text", key:`${date}|${merchant}|${amount}` });
    merchant = null; amount = null; time = "";
  };
  for (const line of lines) {
    if (dateRe.test(line))   { flush(false); date = line; continue; }
    if (line === "승인취소") { flush(true);  continue; }
    if (NOISE.some(p => p.test(line))) continue;
    const am = line.match(amtRe);
    if (am) { amount = parseInt(am[1].replace(/,/g,""), 10); continue; }
    if (/^\d{2}:\d{2}$/.test(line)) { time = line; continue; }
    if (merchant && amount !== null) flush(false);
    if (line) merchant = line;
  }
  flush(false); return res;
}

/* ─────────────────────────────────────────
   엑셀 파서
───────────────────────────────────────── */
async function parseTxnsExcel(arrayBuffer) {
  const XLSX = await loadXLSX();
  const wb = XLSX.read(arrayBuffer, { type:"array", cellDates:true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval:"" });

  const findCol = (keys, candidates) =>
    candidates.find(c => keys.some(k => String(k).includes(c)));

  const keys = rows[0] ? Object.keys(rows[0]) : [];
  const colDate     = findCol(keys, ["거래일","이용일","결제일","날짜"]);
  const colMerchant = findCol(keys, ["가맹점명","상호명","이용가맹점","가맹점"]);
  const colAmount   = findCol(keys, ["금액","이용금액","결제금액","청구금액"]);
  const colCancel   = findCol(keys, ["취소상태","취소여부","매입구분","비고"]);

  const result = [];
  for (const row of rows) {
    const rawMerch = colMerchant ? row[colMerchant] : "";
    const rawAmt   = colAmount   ? row[colAmount]   : "";
    if (!rawMerch || !rawAmt) continue;
    const amtNum = typeof rawAmt === "number" ? rawAmt : parseInt(String(rawAmt).replace(/[^0-9]/g,""), 10);
    if (!amtNum || isNaN(amtNum) || amtNum <= 0) continue;
    if (String(rawMerch).includes("총") && String(rawMerch).includes("건")) continue;

    const rawDate = colDate ? row[colDate] : "";
    let date = "알수없음", time = "";
    if (rawDate) {
      const ds = String(rawDate);
      const m = ds.match(/(\d{4}[.\-\/]\d{2}[.\-\/]\d{2})/);
      if (m) {
        date = m[1].replace(/[-\/]/g,".");
        const tm = ds.match(/(\d{2}:\d{2})/);
        if (tm) time = tm[1];
      } else if (rawDate instanceof Date) {
        const d = rawDate;
        date = `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,"0")}.${String(d.getDate()).padStart(2,"0")}`;
        time = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
      }
    }
    const cancelled = colCancel ? String(row[colCancel]).includes("취소") : false;
    result.push({ date, merchant:String(rawMerch).trim(), amount:amtNum, time, cancelled, source:"excel", key:`${date}|${rawMerch}|${amtNum}` });
  }
  return result;
}

function mergeData(existing, incoming) {
  const keys = new Set(existing.map(t => t.key));
  const added = incoming.filter(t => !keys.has(t.key));
  return { merged:[...existing,...added].sort((a,b) => b.date.localeCompare(a.date)), count:added.length };
}

/* ─────────────────────────────────────────
   카테고리 (세분화 버전)
   실제 신한카드 데이터 기반으로 확장
───────────────────────────────────────── */
const CATS = [
  {
    id:"cafe", label:"카페·음료", emoji:"☕", bg:"#FEF3C7", fg:"#92400E",
    kw:["빽다방","스타벅스","바나프레소","공차","쿠지","우지커피","쥬씨","커피","매머드커피","카페","coffee","메가엠지씨","메가커피","이디야","투썸","할리스","폴바셋","블루보틀","아메리칸도넛","던킨","드롭탑","탐앤탐스","파스쿠찌","달콤","빈브라더스","브루클린","노티드","레몬테이블"],
  },
  {
    id:"bakery", label:"베이커리·간식", emoji:"🍩", bg:"#FCE7F3", fg:"#9D174D",
    kw:["원도너츠","사롱메이드","태극당","크리스피크림","효자베이커리","떡의작품","부성당","베이글리","베이커리","bakery","uncle","엉클","도넛","파리바게트","뚜레쥬르","성심당","브레드","빵집","떡집","케이크","마카롱","와플","크로플"],
  },
  {
    id:"meal", label:"식비·외식", emoji:"🍽️", bg:"#FFF7ED", fg:"#7C2D12",
    kw:["식당","밥","국","찌개","곱창","삼겹","갈비","돼지","소고기","닭","순대","냉면","막국수","만두","김밥","분식","비빔밥","우동","라멘","라면","파스타","피자","스테이크","돈까스","초밥","스시","회","해물","낙지","쭈꾸미","오리","족발","보쌈","쌈","탕","전골","샤브","훠궈","뷔페","한식","일식","중식","양식","분짜","쌀국수","하노이","쌀국수","호타루","단지국수","어죽","온달해물국","본죽","우성순대","개화식당","킹푸드","멘타카무쇼","나완석"],
  },
  {
    id:"fastfood", label:"패스트푸드", emoji:"🍔", bg:"#FEE2E2", fg:"#991B1B",
    kw:["맥도날드","kfc","케이에프씨","버거킹","롯데리아","맘스터치","서브웨이","써브웨이","subway","노브랜드버거","파파이스","쉐이크쉑","파이브가이즈","고메스퀘어"],
  },
  {
    id:"delivery", label:"배달앱", emoji:"🛵", bg:"#FEE2E2", fg:"#7F1D1D",
    kw:["우아한형제들","쿠팡이츠","배달의민족","요기요"],
  },
  {
    id:"grocery", label:"장보기·마트", emoji:"🛒", bg:"#D1FAE5", fg:"#065F46",
    kw:["이마트","홈플러스","롯데마트","코스트코","마트","슈퍼","농협","로컬푸드","수지농협","웰빙마트","미트홈","나무유통","정남미","이천단위","제천로컬","신림단위농협","킹푸드"],
  },
  {
    id:"convenience", label:"편의점", emoji:"🏪", bg:"#F1F5F9", fg:"#334155",
    kw:["gs25","씨유","cu","세븐일레븐","미니스톱","지에스리테일","비지에프","지에스25","코리아세븐","emart24","이마트24","스토리웨이","with me","위드미"],
  },
  {
    id:"shopping", label:"쇼핑", emoji:"🛍️", bg:"#EDE9FE", fg:"#4C1D95",
    kw:["신세계","백화점","롯데","현대백화점","갤러리아","아울렛","무인양품","다이소","올리브영","아성다이소","스타필드","에스에스지","ssg","더블유컨셉","w컨셉","에이케이플라자","아마존","amazon","에프지코리아","코리아성지"],
  },
  {
    id:"coupang", label:"쿠팡", emoji:"📦", bg:"#DBEAFE", fg:"#1E3A8A",
    kw:["쿠팡"],
  },
  {
    id:"electronics", label:"전자제품", emoji:"📱", bg:"#E0E7FF", fg:"#3730A3",
    kw:["삼성전자","애플","apple","lg전자","에이치지컴퍼니","하이마트","전자랜드","에스엠하이플러스","누하스","nouhaus"],
  },
  {
    id:"fuel", label:"주유비", emoji:"⛽", bg:"#FEF9C3", fg:"#713F12",
    kw:["주유소","주유","sk에너지","gs칼텍스","현대오일뱅크","s-oil","에쓰오일","오일","승지","만당대경","셀프주유","주유"],
  },
  {
    id:"transit", label:"교통", emoji:"🚇", bg:"#E0F2FE", fg:"#0C4A6E",
    kw:["티머니","카카오_택시","코레일","지하철","택시","버스","ktx","기차","톨게이트","하이패스","도로공사","공항","리무진","평택시청"],
  },
  {
    id:"medical", label:"의료·약국", emoji:"🏥", bg:"#FDF2F8", fg:"#831843",
    kw:["약국","의원","병원","한의원","치과","안과","피부과","내과","정형외과","산부인과","소아과","이비인후과","메라키플레이스","나무약국","동산약국","미소약국","죽전 센트럴"],
  },
  {
    id:"utility", label:"공과금·통신", emoji:"💡", bg:"#F0FDF4", fg:"#14532D",
    kw:["한국전력","전기","도시가스","가스","수도","통신","kt","sk텔레콤","lg유플러스","알뜰폰","인터넷","인천도시가스"],
  },
  {
    id:"sub", label:"구독·IT", emoji:"💻", bg:"#EEF2FF", fg:"#3730A3",
    kw:["anthropic","openai","apple","구글페이먼트","google","누하스","네이버 파이낸셜","넷플릭스","netflix","유튜브","youtube","스포티파이","spotify","왓챠","웨이브","시즌","디즈니","애플뮤직","멜론","벅스"],
  },
  {
    id:"culture", label:"문화·여가", emoji:"🎬", bg:"#FFF1F2", fg:"#9F1239",
    kw:["cgv","씨지브이","메가박스","롯데시네마","영화","극장","공연","뮤지컬","전시","박물관","미술관","볼링","당구","노래방","pc방","게임","라운지"],
  },
  {
    id:"travel", label:"여행·숙박", emoji:"✈️", bg:"#CCFBF1", fg:"#134E4A",
    kw:["호텔","모텔","펜션","에어비앤비","airbnb","야놀자","여기어때","제천","강릉","이천태극","치악","휴게소","풀무원","코레일유통","만남의광장","에이치앤디이"],
  },
  {
    id:"fitness", label:"운동·건강", emoji:"💪", bg:"#F0FDF4", fg:"#166534",
    kw:["헬스","짐","gym","필라테스","요가","수영","골프","스크린","스포츠","운동"],
  },
];

/* ─────────────────────────────────────────
   카테고리 분류 함수
───────────────────────────────────────── */
function getCat(m) {
  const l = m.toLowerCase()
    .replace(/\(주\)|주식회사|㈜|\(주\s*\)/g, "")
    .replace(/\s+/g, "");

  for (const c of CATS) {
    if (c.kw.some(k => l.includes(k.toLowerCase().replace(/\s/g,"")))) return c;
  }
  return { id:"etc", label:"기타", emoji:"•", bg:"#F8FAFC", fg:"#64748B" };
}

function cleanM(m) {
  return m
    .replace(/^\(주\)\s*|^주식회사\s*|^농업회사법인\(주\)|^㈜/g,"")
    .replace(/\s*(강남우성점|수지구청역점|수지구청점|역삼점|죽전점|이천점|수지점|스타필드 수원점|서초우성직영점|서초뱅뱅점|뱅뱅사거리점|수지에이스점|강남역점|풍덕천3호점|옥수역점|용인수지DT점|판교유스|익스프레스|판교테크노밸리점|평택통복시장점|광교점|용인수지점)/g,"")
    .replace(/\s*SAN FRANCISCO USA/g,"")
    .replace(/\s*INDIA PRIVATE.*/g,"")
    .trim().slice(0,22);
}

/* ─────────────────────────────────────────
   스토리지 (아티팩트=window.storage, Vercel=localStorage)
───────────────────────────────────────── */
const SK = "spendsight-v9";
async function dbLoad() {
  try {
    if (typeof window !== "undefined" && window.storage) {
      const r = await window.storage.get(SK);
      return r ? JSON.parse(r.value) : null;
    }
    const r = localStorage.getItem(SK);
    return r ? JSON.parse(r) : null;
  } catch { return null; }
}
async function dbSave(d) {
  try {
    if (typeof window !== "undefined" && window.storage) {
      await window.storage.set(SK, JSON.stringify(d)); return;
    }
    localStorage.setItem(SK, JSON.stringify(d));
  } catch {}
}

/* ─────────────────────────────────────────
   카운팅 애니메이션
───────────────────────────────────────── */
function useCount(target, dur = 900) {
  const [val, setVal] = useState(0);
  const prev = useRef(0);
  useEffect(() => {
    const s = prev.current, d = target - s;
    if (!d) return;
    const steps = 40, step = dur / steps; let i = 0;
    const id = setInterval(() => {
      i++; const t = i/steps, e = t<.5 ? 2*t*t : -1+(4-2*t)*t;
      setVal(Math.round(s + d * e));
      if (i >= steps) { clearInterval(id); prev.current = target; }
    }, step);
    return () => clearInterval(id);
  }, [target, dur]);
  return val;
}
function AnimNum({ value, suffix = "" }) {
  const v = useCount(value);
  return <span>{v.toLocaleString("ko-KR")}{suffix}</span>;
}

/* ─────────────────────────────────────────
   차트 툴팁
───────────────────────────────────────── */
const PeakDot = ({ cx, cy, payload }) => {
  if (!payload?.isPeak) return null;
  return <g>
    <circle cx={cx} cy={cy} r={5} fill="#7C3AED" stroke="#fff" strokeWidth={2}/>
    <text x={cx} y={cy-10} textAnchor="middle" fontSize={8} fontWeight={700} fill="#7C3AED">최대</text>
  </g>;
};
const ChartTip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return <div style={{ background:"#fff", border:"1px solid #E2E8F0", borderRadius:14, padding:"10px 14px", boxShadow:"0 4px 20px rgba(0,0,0,0.08)" }}>
    <div style={{ fontSize:11, color:"#94A3B8", marginBottom:3 }}>{label}</div>
    <div style={{ fontSize:14, fontWeight:700, color:"#0F172A" }}>{payload[0].value.toLocaleString()}원</div>
    {payload[0]?.payload?.isPeak && <div style={{ fontSize:10, fontWeight:700, color:"#7C3AED", marginTop:3 }}>◆ 최대 지출일</div>}
  </div>;
};
const PieTip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0];
  return <div style={{ background:"#fff", border:"1px solid #E2E8F0", borderRadius:14, padding:"10px 14px", boxShadow:"0 4px 20px rgba(0,0,0,0.08)" }}>
    <div style={{ fontSize:12, fontWeight:600, color:"#0F172A" }}>{d.name}</div>
    <div style={{ fontSize:11, color:"#94A3B8" }}>{d.value.toLocaleString()}원 · {d.payload.pct?.toFixed(0)}%</div>
  </div>;
};

/* ─────────────────────────────────────────
   바텀 시트
───────────────────────────────────────── */
function Sheet({ open, onClose, title, subtitle, children }) {
  useEffect(() => {
    const h = e => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  if (!open) return null;
  return (
    <div style={{ position:"fixed", inset:0, zIndex:200, display:"flex", alignItems:"flex-end", justifyContent:"center", background:"rgba(0,0,0,0.35)", backdropFilter:"blur(6px)" }} onClick={onClose}>
      <div style={{ background:"#fff", borderRadius:"28px 28px 0 0", width:"100%", maxWidth:580, maxHeight:"82vh", overflow:"hidden", display:"flex", flexDirection:"column", boxShadow:"0 -12px 60px rgba(0,0,0,0.18)" }} onClick={e => e.stopPropagation()} className="sheet-up">
        <div style={{ display:"flex", justifyContent:"center", padding:"12px 0 0" }}>
          <div style={{ width:40, height:4, borderRadius:4, background:"#E2E8F0" }}/>
        </div>
        <div style={{ padding:"16px 28px 12px", borderBottom:"1px solid #F1F5F9" }}>
          <div style={{ fontSize:17, fontWeight:700, color:"#0F172A", letterSpacing:"-0.02em" }}>{title}</div>
          {subtitle && <div style={{ fontSize:13, color:"#94A3B8", marginTop:2 }}>{subtitle}</div>}
        </div>
        <div style={{ overflow:"auto", flex:1, padding:"8px 0" }}>{children}</div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────
   내역 Row
───────────────────────────────────────── */
function TxRow({ t, onClick }) {
  const cat = getCat(t.merchant);
  return (
    <button onClick={onClick} style={{ display:"flex", alignItems:"center", gap:14, width:"100%", padding:"13px 0", background:"none", border:"none", cursor:"pointer", textAlign:"left" }} className="tx-row">
      <div style={{ width:44, height:44, borderRadius:14, background:cat.bg, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 }}>{cat.emoji}</div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <span style={{ fontSize:14, fontWeight:600, color:t.cancelled?"#CBD5E1":"#0F172A", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", letterSpacing:"-0.01em", textDecoration:t.cancelled?"line-through":"none" }}>
            {cleanM(t.merchant)}
          </span>
          {t.source === "excel" && <span style={{ fontSize:9, fontWeight:700, padding:"1px 5px", borderRadius:4, background:"#EEF2FF", color:"#3730A3", flexShrink:0 }}>XLS</span>}
        </div>
        <div style={{ fontSize:12, color:"#94A3B8", marginTop:2 }}>{t.date?.slice(5)} {t.time}</div>
      </div>
      <div style={{ textAlign:"right", flexShrink:0 }}>
        <div style={{ fontSize:15, fontWeight:700, color:t.cancelled?"#CBD5E1":"#0F172A", letterSpacing:"-0.02em" }}>{t.amount.toLocaleString()}원</div>
        {t.cancelled && <div style={{ fontSize:10, color:"#CBD5E1" }}>취소</div>}
      </div>
    </button>
  );
}

/* ─────────────────────────────────────────
   내역 추가 모달
───────────────────────────────────────── */
function ImportModal({ onClose, onAdd }) {
  const [mode, setMode]           = useState("excel");
  const [rawText, setRawText]     = useState("");
  const [excelRows, setExcelRows] = useState(null);
  const [excelFile, setExcelFile] = useState("");
  const [loading, setLoading]     = useState(false);
  const fileRef = useRef();

  const handleFile = async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    setLoading(true); setExcelFile(f.name); setExcelRows(null);
    try {
      const rows = await parseTxnsExcel(await f.arrayBuffer());
      if (!rows.length) throw new Error("빈 결과");
      setExcelRows(rows);
    } catch {
      setExcelFile(""); setExcelRows(null);
      alert("파일을 읽을 수 없어요.\n카드사 엑셀(.xls/.xlsx)인지 확인해주세요.");
    }
    setLoading(false);
  };

  const previewCount = mode === "text" ? parseTxnsText(rawText).length : (excelRows?.length ?? 0);

  return (
    <div style={{ position:"fixed", inset:0, zIndex:300, display:"flex", alignItems:"flex-end", justifyContent:"center", background:"rgba(0,0,0,0.45)", backdropFilter:"blur(8px)" }} onClick={onClose}>
      <div style={{ background:"#fff", borderRadius:"28px 28px 0 0", width:"100%", maxWidth:580, maxHeight:"88vh", overflow:"hidden", display:"flex", flexDirection:"column", boxShadow:"0 -12px 60px rgba(0,0,0,0.2)" }} onClick={e => e.stopPropagation()} className="sheet-up">
        <div style={{ display:"flex", justifyContent:"center", padding:"12px 0 0" }}>
          <div style={{ width:40, height:4, borderRadius:4, background:"#E2E8F0" }}/>
        </div>
        <div style={{ padding:"16px 24px 12px", borderBottom:"1px solid #F1F5F9", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div>
            <div style={{ fontSize:17, fontWeight:700, color:"#0F172A" }}>카드 내역 추가</div>
            <div style={{ fontSize:13, color:"#94A3B8", marginTop:2 }}>엑셀 파일 또는 텍스트 붙여넣기</div>
          </div>
          <button onClick={onClose} style={{ background:"#F1F5F9", border:"none", borderRadius:10, padding:"6px 14px", fontSize:12, color:"#64748B", cursor:"pointer", fontFamily:"inherit", fontWeight:600 }}>닫기</button>
        </div>

        <div style={{ padding:"14px 24px 0" }}>
          <div style={{ display:"flex", background:"#F8FAFC", borderRadius:12, padding:3, gap:3 }}>
            {[["excel","📊 엑셀 파일"],["text","📋 텍스트"]].map(([id,lbl]) => (
              <button key={id} onClick={() => setMode(id)}
                style={{ flex:1, padding:"8px 0", borderRadius:10, border:"none", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"inherit", transition:"all .15s",
                  background:mode===id?"#fff":"transparent", color:mode===id?"#0F172A":"#94A3B8",
                  boxShadow:mode===id?"0 1px 4px rgba(0,0,0,0.08)":"none" }}>
                {lbl}
              </button>
            ))}
          </div>
        </div>

        <div style={{ flex:1, overflow:"auto", padding:"16px 24px" }}>
          {mode === "excel" && (
            <>
              <div style={{ fontSize:12, color:"#94A3B8", marginBottom:14, lineHeight:1.8 }}>
                카드사 홈페이지에서 다운로드한<br/>
                <strong style={{ color:"#334155" }}>.xls / .xlsx</strong> 파일을 업로드하세요.<br/>
                <span style={{ fontSize:11 }}>신한·삼성·국민·현대·롯데카드 지원</span>
              </div>
              <div
                style={{ border:"2px dashed #E2E8F0", borderRadius:18, padding:"40px 24px", textAlign:"center", cursor:"pointer", background:excelFile?"#F0FDF4":"#FAFAFA", transition:"all .2s" }}
                onClick={() => fileRef.current?.click()}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if(f) handleFile({ target:{ files:[f] } }); }}
              >
                {loading ? (
                  <div style={{ fontSize:14, color:"#94A3B8" }}>📊 파일 분석 중…</div>
                ) : excelFile ? (
                  <>
                    <div style={{ fontSize:36, marginBottom:8 }}>✅</div>
                    <div style={{ fontSize:14, fontWeight:700, color:"#059669", marginBottom:4 }}>{excelFile}</div>
                    <div style={{ fontSize:13, color:"#34D399" }}>{excelRows?.length}건 감지됨</div>
                    <div style={{ fontSize:11, color:"#94A3B8", marginTop:8 }}>다른 파일을 선택하려면 탭하세요</div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize:40, marginBottom:10 }}>📁</div>
                    <div style={{ fontSize:14, fontWeight:600, color:"#334155", marginBottom:4 }}>파일을 여기에 드래그하거나 탭하세요</div>
                    <div style={{ fontSize:12, color:"#94A3B8" }}>.xls · .xlsx 지원</div>
                  </>
                )}
              </div>
              <input ref={fileRef} type="file" accept=".xls,.xlsx" style={{ display:"none" }} onChange={handleFile}/>
            </>
          )}

          {mode === "text" && (
            <>
              <div style={{ fontSize:12, color:"#94A3B8", marginBottom:10, lineHeight:1.8 }}>
                카드사 앱 → 이용내역 전체 복사 후 붙여넣기
              </div>
              <textarea value={rawText} onChange={e => setRawText(e.target.value)}
                placeholder={"2026.05.01\n스타벅스\n14:30 본인6627 일시불\n6,500 원"}
                style={{ width:"100%", minHeight:200, border:"1.5px solid #E2E8F0", borderRadius:16, padding:"14px 16px", fontSize:12, fontFamily:"monospace", color:"#334155", background:"#FAFAFA", outline:"none", resize:"vertical", lineHeight:1.7 }}/>
              <div style={{ fontSize:12, color:"#94A3B8", marginTop:8 }}>
                {rawText.trim() ? `${previewCount}건 감지됨` : "텍스트를 붙여넣어 주세요"}
              </div>
            </>
          )}
        </div>

        <div style={{ padding:"12px 24px 24px", borderTop:"1px solid #F8FAFC", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <span style={{ fontSize:12, color:"#94A3B8" }}>{previewCount > 0 ? `${previewCount}건 추가 예정` : ""}</span>
          <button
            onClick={() => { const rows = mode==="text" ? parseTxnsText(rawText) : excelRows; if(rows?.length) onAdd(rows); onClose(); }}
            disabled={previewCount === 0}
            style={{ background:previewCount>0?"#0F172A":"#E2E8F0", color:previewCount>0?"#fff":"#94A3B8", border:"none", borderRadius:14, padding:"12px 28px", fontSize:14, fontWeight:700, cursor:previewCount>0?"pointer":"default", fontFamily:"inherit", transition:"all .2s" }}>
            추가하기
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────
   메인 앱
───────────────────────────────────────── */
const CS  = { background:"#fff", borderRadius:24, padding:"20px", boxShadow:"0 1px 4px rgba(0,0,0,0.06)" };
const IBN = { width:36, height:36, borderRadius:12, background:"#F1F5F9", border:"none", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", color:"#64748B", fontSize:16, fontWeight:700 };
const TST = { position:"fixed", bottom:90, left:"50%", transform:"translateX(-50%)", background:"#0F172A", color:"#fff", borderRadius:14, padding:"12px 20px", fontSize:13, fontWeight:600, zIndex:400, whiteSpace:"nowrap", boxShadow:"0 8px 30px rgba(0,0,0,0.25)" };
const INDIGO = ["#C7D2FE","#A5B4FC","#818CF8","#6366F1","#4F46E5","#4338CA","#3730A3","#312E81","#1E1B4B","#0F0A3F"];

export default function App() {
  const [txns, setTxns]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [tab, setTab]           = useState(0);
  const [prevTab, setPrevTab]   = useState(0);
  const [sheet, setSheet]       = useState(null);
  const [importOpen, setImport] = useState(false);
  const [toast, setToast]       = useState(null);
  const [period, setPeriod]     = useState("all");

  useEffect(() => {
    (async () => {
      const stored = await dbLoad();
      setTxns(stored?.length ? stored : []);
      setLoading(false);
      loadXLSX().catch(() => {});
    })();
  }, []);

  const showToast = useCallback(msg => { setToast(msg); setTimeout(() => setToast(null), 2800); }, []);
  const switchTab = i => { setPrevTab(tab); setTab(i); };

  const months = useMemo(() => {
    const ms = new Set(txns.map(t => t.date?.slice(0,7)).filter(Boolean));
    return [...ms].sort().reverse();
  }, [txns]);

  const PERIODS = useMemo(() => [
    { id:"all", label:"전체", from:"", to:"" },
    ...months.map(m => {
      const [y,mo] = m.split(".");
      const last = new Date(+y,+mo,0).getDate();
      return { id:m, label:`${+mo}월`, from:`${m}.01`, to:`${m}.${String(last).padStart(2,"0")}` };
    }),
  ], [months]);

  const cp = PERIODS.find(p => p.id === period) || PERIODS[0];

  const valid = useMemo(() =>
    txns.filter(t => {
      if (t.cancelled) return false;
      if (cp.from && t.date < cp.from) return false;
      if (cp.to   && t.date > cp.to)   return false;
      return true;
    }).map(t => ({ ...t, cat:getCat(t.merchant) }))
  , [txns, cp]);

  const totalSpend = useMemo(() => valid.reduce((s,t) => s+t.amount, 0), [valid]);
  const activeDays = useMemo(() => [...new Set(valid.map(t => t.date))].length, [valid]);
  const avgDaily   = activeDays ? Math.round(totalSpend/activeDays) : 0;

  const catData = useMemo(() => {
    const m = {};
    for (const t of valid) {
      const c = t.cat;
      if (!m[c.id]) m[c.id] = { ...c, value:0, txns:[] };
      m[c.id].value += t.amount;
      m[c.id].txns.push(t);
    }
    const tot = totalSpend || 1;
    return Object.values(m).sort((a,b) => b.value-a.value).map(c => ({ ...c, pct:c.value/tot*100 }));
  }, [valid, totalSpend]);

  const dayData = useMemo(() => {
    const m = {};
    for (const t of valid) { const d = t.date?.slice(5); if(d) m[d] = (m[d]||0) + t.amount; }
    const entries = Object.entries(m).sort((a,b) => a[0].localeCompare(b[0])).map(([date,amount]) => ({ date, amount }));
    const mx = Math.max(...entries.map(e => e.amount), 0);
    return entries.map(e => ({ ...e, isPeak:e.amount===mx&&mx>0 }));
  }, [valid]);

  const grouped = useMemo(() => {
    const m = {};
    const list = txns.filter(t => {
      if (cp.from && t.date < cp.from) return false;
      if (cp.to   && t.date > cp.to)   return false;
      return true;
    });
    for (const t of list) { if(!m[t.date]) m[t.date]=[]; m[t.date].push(t); }
    return Object.entries(m).sort((a,b) => b[0].localeCompare(a[0]));
  }, [txns, cp]);

  const handleAdd = useCallback(async incoming => {
    const { merged, count } = mergeData(txns, incoming);
    setTxns(merged); await dbSave(merged);
    showToast(`✓ ${count}건 추가 · 중복 ${incoming.length-count}건 제외`);
  }, [txns, showToast]);

  const handleReset = useCallback(async () => {
    if (!confirm("모든 내역을 삭제할까요?")) return;
    setTxns([]); setPeriod("all"); await dbSave([]);
    showToast("초기화 완료");
  }, [showToast]);

  const openCat = c => setSheet({ title:`${c.emoji} ${c.label}`, sub:`${c.txns.length}건 · ${c.value.toLocaleString()}원`, rows:c.txns });
  const openTx  = t => setSheet({ title:cleanM(t.merchant), sub:`${t.date} ${t.time}`, rows:[t] });
  const dir = tab > prevTab ? 1 : -1;

  if (loading) return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"#FAFAFA" }}>
      <div style={{ fontSize:13, color:"#CBD5E1", fontFamily:"Manrope,sans-serif" }}>불러오는 중…</div>
    </div>
  );

  const TABS = [{ label:"홈", icon:"◎" },{ label:"내역", icon:"☰" },{ label:"분석", icon:"◈" }];

  return (
    <>
      <FontLink/>
      <div style={{ minHeight:"100vh", background:"#FAFAFA", fontFamily:"Manrope,'Apple SD Gothic Neo',sans-serif", color:"#0F172A", maxWidth:480, margin:"0 auto", position:"relative" }}>
        <style>{CSS}</style>
        {toast && <div style={TST} className="toast-pop">{toast}</div>}

        <Sheet open={!!sheet} onClose={() => setSheet(null)} title={sheet?.title} subtitle={sheet?.sub}>
          {sheet?.rows?.map((t,i) => (
            <div key={i} style={{ padding:"0 24px", borderBottom:i<sheet.rows.length-1?"1px solid #F8FAFC":"none" }}>
              <TxRow t={t} onClick={() => {}}/>
            </div>
          ))}
        </Sheet>

        {importOpen && <ImportModal onClose={() => setImport(false)} onAdd={rows => { handleAdd(rows); setImport(false); }}/>}

        <div style={{ height:48 }}/>

        {/* 헤더 */}
        <div style={{ padding:"0 24px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div>
            <div style={{ fontSize:18, fontWeight:800, letterSpacing:"-0.04em" }}>소비 리포트</div>
            <div style={{ fontSize:11, color:"#CBD5E1", marginTop:1 }}>로그인 없이 사용 가능</div>
          </div>
          <div style={{ display:"flex", gap:8 }}>
            <button onClick={() => setImport(true)} style={IBN}>＋</button>
            <button onClick={handleReset} style={IBN}>↺</button>
          </div>
        </div>

        {/* 기간 필터 */}
        <div style={{ display:"flex", gap:6, padding:"14px 24px 0", overflowX:"auto" }}>
          {PERIODS.map(p => (
            <button key={p.id} onClick={() => setPeriod(p.id)}
              style={{ padding:"6px 16px", borderRadius:100, fontSize:13, fontWeight:600, border:"none", cursor:"pointer", whiteSpace:"nowrap", transition:"all .2s",
                background:period===p.id?"#0F172A":"#F1F5F9", color:period===p.id?"#fff":"#64748B" }}>
              {p.label}
            </button>
          ))}
        </div>

        {/* 페이지 */}
        <div style={{ overflow:"hidden" }}>
          <div key={tab} className={`page-in-${dir>0?"right":"left"}`} style={{ padding:"20px 24px 100px" }}>

            {/* ══ 홈 ══ */}
            {tab === 0 && (
              <div>
                {valid.length === 0 ? (
                  <div style={{ display:"flex", flexDirection:"column", alignItems:"center", padding:"60px 0", gap:16 }}>
                    <div style={{ fontSize:64 }}>💳</div>
                    <div style={{ fontSize:18, fontWeight:800, letterSpacing:"-0.03em" }}>카드 내역이 없어요</div>
                    <div style={{ fontSize:13, color:"#94A3B8", textAlign:"center", lineHeight:1.8, maxWidth:260 }}>
                      <strong style={{ color:"#334155" }}>📊 엑셀 파일</strong>(.xls/.xlsx) 업로드 또는<br/>
                      <strong style={{ color:"#334155" }}>📋 텍스트</strong> 붙여넣기로 시작하세요.
                    </div>
                    <button onClick={() => setImport(true)} style={{ marginTop:8, padding:"13px 32px", borderRadius:16, background:"#0F172A", color:"#fff", border:"none", fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>
                      내역 추가하기
                    </button>
                  </div>
                ) : (<>
                  <div style={{ marginBottom:28 }}>
                    <div style={{ fontSize:13, color:"#94A3B8", fontWeight:500, marginBottom:6 }}>총 지출</div>
                    <div style={{ fontSize:42, fontWeight:800, letterSpacing:"-0.04em", lineHeight:1.1, fontFamily:"'Instrument Serif',serif" }}>
                      <AnimNum value={totalSpend} suffix="원"/>
                    </div>
                    <div style={{ fontSize:13, color:"#94A3B8", marginTop:6 }}>
                      {valid.length}건 · 일평균 <span style={{ color:"#64748B", fontWeight:600 }}>{avgDaily.toLocaleString()}원</span>
                    </div>
                  </div>

                  {/* 차트 */}
                  <div style={{ ...CS, padding:"20px 16px 10px", marginBottom:14 }}>
                    <div style={{ fontSize:11, color:"#94A3B8", fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:12, paddingLeft:4 }}>지출 흐름</div>
                    <ResponsiveContainer width="100%" height={130}>
                      <AreaChart data={dayData} margin={{ top:18, right:4, left:-28, bottom:0 }}>
                        <defs>
                          <linearGradient id="ga" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#A5B4FC" stopOpacity={0.35}/>
                            <stop offset="100%" stopColor="#A5B4FC" stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <XAxis dataKey="date" tick={{ fill:"#CBD5E1", fontSize:9 }} axisLine={false} tickLine={false} interval={Math.ceil(dayData.length/5)-1}/>
                        <YAxis tick={{ fill:"#CBD5E1", fontSize:9 }} axisLine={false} tickLine={false} tickFormatter={v => v>=10000?(v/10000).toFixed(0)+"만":v}/>
                        <Tooltip content={<ChartTip/>} cursor={{ stroke:"#E2E8F0", strokeWidth:1 }}/>
                        <Area type="monotone" dataKey="amount" stroke="#818CF8" strokeWidth={1.5} fill="url(#ga)" dot={<PeakDot/>} activeDot={{ r:3, fill:"#818CF8", stroke:"#fff", strokeWidth:2 }}/>
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>

                  {/* 카테고리 상위 5개 */}
                  <div style={{ ...CS, marginBottom:14 }}>
                    <div style={{ fontSize:11, color:"#94A3B8", fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:16 }}>카테고리</div>
                    {catData.slice(0,5).map((c,i) => (
                      <button key={i} onClick={() => openCat(c)}
                        style={{ display:"flex", alignItems:"center", gap:12, width:"100%", padding:"10px 0", background:"none", border:"none", cursor:"pointer", borderBottom:i<4?"1px solid #F8FAFC":"none" }}>
                        <div style={{ width:36, height:36, borderRadius:11, background:c.bg, display:"flex", alignItems:"center", justifyContent:"center", fontSize:17, flexShrink:0 }}>{c.emoji}</div>
                        <div style={{ flex:1, textAlign:"left" }}>
                          <div style={{ fontSize:14, fontWeight:600 }}>{c.label}</div>
                          <div style={{ height:3, background:"#F1F5F9", borderRadius:2, marginTop:4, overflow:"hidden" }}>
                            <div style={{ height:"100%", width:`${c.pct}%`, background:"#0F172A", borderRadius:2 }}/>
                          </div>
                        </div>
                        <div style={{ textAlign:"right", flexShrink:0 }}>
                          <div style={{ fontSize:14, fontWeight:700, letterSpacing:"-0.02em" }}>{c.value.toLocaleString()}</div>
                          <div style={{ fontSize:11, color:"#CBD5E1" }}>{c.pct.toFixed(0)}%</div>
                        </div>
                      </button>
                    ))}
                    {catData.length > 5 && (
                      <button onClick={() => switchTab(2)} style={{ display:"block", width:"100%", textAlign:"center", padding:"12px", fontSize:13, color:"#94A3B8", background:"none", border:"none", cursor:"pointer", marginTop:4 }}>
                        전체 보기 →
                      </button>
                    )}
                  </div>
                </>)}
              </div>
            )}

            {/* ══ 내역 ══ */}
            {tab === 1 && (
              <div>
                <div style={{ fontSize:11, color:"#94A3B8", fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:16 }}>결제 내역</div>
                {grouped.length === 0 ? (
                  <div style={{ display:"flex", flexDirection:"column", alignItems:"center", padding:"60px 0", gap:16 }}>
                    <div style={{ fontSize:56 }}>🧾</div>
                    <div style={{ fontSize:17, fontWeight:700 }}>내역이 없어요</div>
                    <button onClick={() => setImport(true)} style={{ padding:"10px 24px", borderRadius:14, background:"#0F172A", color:"#fff", border:"none", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>내역 추가하기</button>
                  </div>
                ) : grouped.map(([date, rows], gi) => (
                  <div key={gi} style={{ marginBottom:20 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:6 }}>
                      <div style={{ fontSize:13, fontWeight:700, color:"#64748B" }}>{date.slice(5).replace(".","/")}</div>
                      <div style={{ fontSize:13, color:"#CBD5E1" }}>{rows.filter(r=>!r.cancelled).reduce((s,r)=>s+r.amount,0).toLocaleString()}원</div>
                    </div>
                    <div style={{ ...CS, padding:"0 16px" }}>
                      {rows.map((t,i) => (
                        <div key={i} style={{ borderBottom:i<rows.length-1?"1px solid #F8FAFC":"none" }}>
                          <TxRow t={t} onClick={() => openTx(t)}/>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ══ 분석 ══ */}
            {tab === 2 && (
              <div>
                {valid.length === 0 ? (
                  <div style={{ display:"flex", flexDirection:"column", alignItems:"center", padding:"60px 0", gap:14 }}>
                    <div style={{ fontSize:56 }}>📊</div>
                    <div style={{ fontSize:17, fontWeight:700 }}>분석할 데이터가 없어요</div>
                  </div>
                ) : (<>
                  {/* 도넛 차트 */}
                  <div style={{ ...CS, marginBottom:14 }}>
                    <div style={{ fontSize:11, color:"#94A3B8", fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:4 }}>카테고리 분포</div>
                    <div style={{ display:"flex", alignItems:"center" }}>
                      <div style={{ width:160, flexShrink:0 }}>
                        <ResponsiveContainer width={160} height={160}>
                          <PieChart>
                            <Pie data={catData} cx="50%" cy="50%" innerRadius={44} outerRadius={68} paddingAngle={2} dataKey="value" onClick={d => openCat(d)} style={{ cursor:"pointer" }}>
                              {catData.map((_,i) => <Cell key={i} fill={INDIGO[Math.min(i,INDIGO.length-1)]}/>)}
                            </Pie>
                            <Tooltip content={<PieTip/>}/>
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                      <div style={{ flex:1, display:"flex", flexDirection:"column", gap:7 }}>
                        {catData.slice(0,5).map((c,i) => (
                          <button key={i} onClick={() => openCat(c)} style={{ display:"flex", alignItems:"center", gap:8, background:"none", border:"none", cursor:"pointer", padding:"2px 0" }}>
                            <div style={{ width:8, height:8, borderRadius:2, background:INDIGO[i], flexShrink:0 }}/>
                            <span style={{ fontSize:12, color:"#475569" }}>{c.label}</span>
                            <span style={{ fontSize:11, color:"#CBD5E1", marginLeft:"auto", fontFamily:"monospace" }}>{c.pct.toFixed(0)}%</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* 전체 카테고리 목록 */}
                  <div style={{ ...CS }}>
                    <div style={{ fontSize:11, color:"#94A3B8", fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:12 }}>전체 카테고리</div>
                    {catData.map((c,i) => (
                      <button key={i} onClick={() => openCat(c)}
                        style={{ display:"flex", alignItems:"center", gap:12, width:"100%", padding:"11px 0", background:"none", border:"none", cursor:"pointer", borderBottom:i<catData.length-1?"1px solid #F8FAFC":"none" }}>
                        <div style={{ width:38, height:38, borderRadius:12, background:c.bg, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, flexShrink:0 }}>{c.emoji}</div>
                        <div style={{ flex:1, textAlign:"left" }}>
                          <div style={{ fontSize:14, fontWeight:600 }}>{c.label}</div>
                          <div style={{ fontSize:12, color:"#94A3B8" }}>{c.txns.length}건</div>
                        </div>
                        <div style={{ textAlign:"right", flexShrink:0 }}>
                          <div style={{ fontSize:14, fontWeight:700, letterSpacing:"-0.02em" }}>{c.value.toLocaleString()}</div>
                          <div style={{ fontSize:11, color:"#CBD5E1" }}>{c.pct.toFixed(0)}%</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </>)}
              </div>
            )}
          </div>
        </div>

        {/* 하단 네비 */}
        <div style={{ position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:480, background:"rgba(255,255,255,0.92)", backdropFilter:"blur(20px)", borderTop:"1px solid #F1F5F9", display:"flex", zIndex:100 }}>
          {TABS.map((n,i) => (
            <button key={i} onClick={() => switchTab(i)}
              style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:3, padding:"12px 0 16px", background:"none", border:"none", cursor:"pointer", opacity:tab===i?1:0.38 }}>
              <div style={{ fontSize:20, lineHeight:1 }}>{n.icon}</div>
              <div style={{ fontSize:10, fontWeight:700, color:tab===i?"#0F172A":"#94A3B8", letterSpacing:"0.02em" }}>{n.label}</div>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

const CSS = `
* { box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent; }
::-webkit-scrollbar { display:none; }
.sheet-up { animation: sheetUp 0.32s cubic-bezier(0.16,1,0.3,1); }
@keyframes sheetUp { from { transform:translateY(100%); } to { transform:translateY(0); } }
.toast-pop { animation: toastPop 0.22s ease; }
@keyframes toastPop { from { opacity:0; transform:translateX(-50%) translateY(8px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }
.page-in-right { animation: slideR 0.28s cubic-bezier(0.25,1,0.5,1); }
@keyframes slideR { from { opacity:0; transform:translateX(28px); } to { opacity:1; transform:translateX(0); } }
.page-in-left { animation: slideL 0.28s cubic-bezier(0.25,1,0.5,1); }
@keyframes slideL { from { opacity:0; transform:translateX(-28px); } to { opacity:1; transform:translateX(0); } }
.tx-row:hover { background:#FAFAFA; border-radius:14px; }
.tx-row:active { background:#F1F5F9; border-radius:14px; }
`;
