import { useState, useEffect, useRef } from "react";

// -- charge engine -------------------------------------------------------------
function calcC(action, qty, price, buyPrice, holdDays) {
  var tv = qty * price;
  var broker = tv * 0.004; if (broker < 10) broker = 10;
  var sebon = tv * 0.000015; var dp = 25;
  var cgt = 0; var gpl = 0; var npl = 0;
  if (action === "SELL" && buyPrice > 0) {
    gpl = (price - buyPrice) * qty;
    if (gpl > 0) cgt = gpl * (holdDays >= 365 ? 0.05 : 0.075);
  }
  var tot = broker + sebon + dp + cgt;
  var be = action === "BUY" ? (tv + broker + sebon + dp) / qty : 0;
  var net = action === "BUY" ? tv + tot : tv - tot;
  if (action === "SELL" && buyPrice > 0) npl = gpl - tot;
  return { tv:tv, b:broker, s:sebon, d:dp, cgt:cgt, tot:tot, be:be, net:net, gpl:gpl, npl:npl };
}

// -- storage -------------------------------------------------------------------
function dbGet(k) {
  return window.storage.get(k).then(function(r) { return r ? JSON.parse(r.value) : null; }).catch(function() { return null; });
}
function dbSet(k, v) { window.storage.set(k, JSON.stringify(v)).catch(function() {}); }

// -- utils ---------------------------------------------------------------------
function toRs(n) { return "Rs " + Math.round(Math.abs(n)).toLocaleString("en-IN"); }
function toRs2(n) { return "Rs " + Math.abs(n).toFixed(2); }
function signed(n) { return (n >= 0 ? "+" : "-") + toRs(n); }
function toPct(n) { if (n == null) return "-"; return (n >= 0 ? "+" : "") + Number(n).toFixed(2) + "%"; }
function timeAgo(d) {
  var s = Math.floor((Date.now() - new Date(d)) / 1000);
  if (s < 60) return s + "s"; if (s < 3600) return Math.floor(s/60) + "m";
  if (s < 86400) return Math.floor(s/3600) + "h"; return Math.floor(s/86400) + "d";
}
function daysAgo(d) { return Math.floor((Date.now() - new Date(d)) / 86400000); }
function parseJ(raw) {
  if (!raw) return null;
  try {
    var fence = String.fromCharCode(96,96,96);
    var c = raw.split(fence+"json").join("").split(fence).join("").trim();
    return JSON.parse(c);
  } catch(e1) {
    try {
      var s = raw.indexOf("{"); var sa = raw.indexOf("[");
      if (sa >= 0 && (s < 0 || sa < s)) s = sa;
      var e = raw.lastIndexOf("}"); var ea = raw.lastIndexOf("]");
      if (ea > e) e = ea;
      if (s >= 0 && e > s) return JSON.parse(raw.slice(s, e+1));
    } catch(e2) {}
    return null;
  }
}

// -- AI call -------------------------------------------------------------------
function callAI(prompt, cfg) {
  var body = { model:"claude-sonnet-4-20250514", max_tokens:1500, messages:[{role:"user",content:prompt}] };
  if (cfg && cfg.search) body.tools = [{type:"web_search_20250305",name:"web_search"}];
  return fetch("https://api.anthropic.com/v1/messages", {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.error) throw new Error(d.error.message);
    var t = (d.content||[]).filter(function(b) { return b.type === "text"; });
    return t.length > 0 ? t[t.length-1].text : "";
  });
}

// -- constants -----------------------------------------------------------------
var SIG_COLORS = { BUY:"#10b981", SELL:"#ef4444", WATCH:"#f59e0b", AVOID:"#64748b" };
var DEFAULT_WL = ["NABIL","UPPER","HIDCL","GBIME","NICA","NTC"];
var DEFAULT_SETTINGS = {
  discovery_on: true,
  discovery_depth: 8,
  autoadd_threshold: "BUY",
  autoremove_on: true,
  autoremove_after: 3,
  sector_focus: { banks:true, hydro:true, microfinance:true, insurance:true, devbanks:true, finance:true }
};
var EXCHANGES = {
  NEPSE: { id:"NEPSE", name:"Nepal Stock Exchange", currency:"NPR", symbol:"Rs", timezone:"Asia/Kathmandu", hours:"11:00-15:00", source:"merolagani.com", flag:"NP" },
  NYSE:  { id:"NYSE",  name:"New York Stock Exchange", currency:"USD", symbol:"$",  timezone:"America/New_York",  hours:"09:30-16:00", source:"finance.yahoo.com",  flag:"US" }
};

var SECTORS = ["banks","hydro","microfinance","insurance","devbanks","finance"];
var SECTOR_LABELS = { banks:"Commercial Banks", hydro:"Hydropower", microfinance:"Microfinance", insurance:"Insurance", devbanks:"Dev Banks", finance:"Finance" };

// -- css -----------------------------------------------------------------------
function injectCSS() {
  var s = document.createElement("style");
  s.textContent = [
    "*{box-sizing:border-box;margin:0;padding:0}",
    "body{background:#07090e}",
    "::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:#1e2840;border-radius:3px}",
    "input,textarea,select{background:#0b0e16;border:1px solid #1e2840;border-radius:8px;padding:9px 13px;font-size:12px;color:#c8d4e8;font-family:inherit;outline:none;width:100%;transition:all .15s}",
    "input:focus,textarea:focus,select:focus{border-color:#3b82f6;box-shadow:0 0 0 3px #3b82f610}",
    "button{font-family:inherit;cursor:pointer;transition:all .15s}",

    "@keyframes _pulse{0%,100%{opacity:.15}50%{opacity:.9}}",
    "@keyframes _dot{0%,100%{opacity:1}50%{opacity:.3}}",
    "@keyframes _fadeup{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}",
    ".fadeup{animation:_fadeup .2s ease forwards}"
  ].join("");
  document.head.appendChild(s);
  var l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap";
  document.head.appendChild(l);
}

// -----------------------------------------------------------------------------
function BuyChargePreview(props) {
  var q=parseFloat(props.qty); var p=props.price;
  if(!q||!p) return null;
  var ch=calcC("BUY",q,p,0,0);
  return (
    <div style={{fontSize:10,color:"#4a5568",marginBottom:8,padding:"6px 10px",background:"#07090e",borderRadius:6,border:"1px solid #1e2840",display:"flex",gap:12,flexWrap:"wrap"}}>
      <span>{"pay "}<span style={{color:"#e2e8f0",fontWeight:500}}>{toRs(ch.net)}</span></span>
      <span>{"broker "}<span style={{color:"#c8d4e8"}}>{toRs2(ch.b)}</span></span>
      <span>{"DP "}<span style={{color:"#c8d4e8"}}>{"Rs25"}</span></span>
      <span>{"BE "}<span style={{color:"#10b981",fontWeight:500}}>{"Rs"+ch.be.toFixed(2)}</span></span>
    </div>
  );
}

export default function App() {
  var st = useState;
  var tab_s=st("today"); var tab=tab_s[0]; var setTab=tab_s[1];
  var port_s=st([]); var portfolio=port_s[0]; var setPortfolio=port_s[1];
  var tlog_s=st([]); var tradeLog=tlog_s[0]; var setTradeLog=tlog_s[1];
  var sigs_s=st([]); var signals=sigs_s[0]; var setSignals=sigs_s[1];
  var sc_s=st({}); var stockCache=sc_s[0]; var setStockCache=sc_s[1];
  var mkt_s=st(null); var market=mkt_s[0]; var setMarket=mkt_s[1];
  var brief_s=st(null); var brief=brief_s[0]; var setBrief=brief_s[1];
  var wl_s=st(DEFAULT_WL); var watchlist=wl_s[0]; var setWatchlist=wl_s[1];
  var chat_s=st([]); var chat=chat_s[0]; var setChat=chat_s[1];
  var ci_s=st(""); var chatInput=ci_s[0]; var setChatInput=ci_s[1];
  var cl_s=st(false); var chatLoading=cl_s[0]; var setChatLoading=cl_s[1];
  var mem_s=st({}); var memory=mem_s[0]; var setMemory=mem_s[1];
  var wts_s=st({}); var weights=wts_s[0]; var setWeights=wts_s[1];
  var cfg_s=st(DEFAULT_SETTINGS); var settings=cfg_s[0]; var setSettings=cfg_s[1];
  var exc_s=st("NEPSE"); var exchange=exc_s[0]; var setExchange=exc_s[1];
  // overlay
  var ovs_s=st(null); var ovSym=ovs_s[0]; var setOvSym=ovs_s[1];
  var ovd_s=st(null); var ovData=ovd_s[0]; var setOvData=ovd_s[1];
  var ova_s=st(""); var ovAnalysis=ova_s[0]; var setOvAnalysis=ova_s[1];
  var ovsig_s=st(null); var ovSig=ovsig_s[0]; var setOvSig=ovsig_s[1];
  var ovl_s=st(false); var ovLoading=ovl_s[0]; var setOvLoading=ovl_s[1];
  // buy/sell
  var bt_s=st(null); var buyTarget=bt_s[0]; var setBuyTarget=bt_s[1];
  var bq_s=st(""); var buyQty=bq_s[0]; var setBuyQty=bq_s[1];
  var bsl_s=st(""); var buySL=bsl_s[0]; var setBuySL=bsl_s[1];
  var br_s=st(""); var buyReason=br_s[0]; var setBuyReason=br_s[1];
  var st2_s=st(null); var sellTarget=st2_s[0]; var setSellTarget=st2_s[1];
  var sp_s=st(""); var sellPrice=sp_s[0]; var setSellPrice=sp_s[1];
  var sr_s=st(""); var sellReason=sr_s[0]; var setSellReason=sr_s[1];
  // watchlist input
  var wli_s=st(""); var wlInput=wli_s[0]; var setWlInput=wli_s[1];
  // ui
  var toast_s=st([]); var toasts=toast_s[0]; var setToasts=toast_s[1];
  var log_s=st([]); var logs=log_s[0]; var setLogs=log_s[1];
  var showLog_s=st(false); var showLog=showLog_s[0]; var setShowLog=showLog_s[1];
  var ar_s=st(false); var autoRunning=ar_s[0]; var setAutoRunning=ar_s[1];
  var ss_s=st(""); var scanSym=ss_s[0]; var setScanSym=ss_s[1];
  var scanPhase_s=st(""); var scanPhase=scanPhase_s[0]; var setScanPhase=scanPhase_s[1];
  var sidebar_s=st(false); var sidebarOpen=sidebar_s[0]; var setSidebarOpen=sidebar_s[1];
  var prefill_s=st(""); var askPrefill=prefill_s[0]; var setAskPrefill=prefill_s[1];

  var chatEnd = useRef(null);
  var sidebarEnd = useRef(null);
  var didScan = useRef(false);
  var logExpanded_s = useState({}); var logExpanded = logExpanded_s[0]; var setLogExpanded = logExpanded_s[1];
  var logPanel_s = useState(false); var logPanelOpen = logPanel_s[0]; var setLogPanelOpen = logPanel_s[1];

  useEffect(function() { injectCSS(); }, []);

  useEffect(function() {
    Promise.all([
      dbGet("ni:p"),dbGet("ni:tl"),dbGet("ni:sig"),dbGet("ni:mkt"),
      dbGet("ni:brief"),dbGet("ni:wl"),dbGet("ni:chat"),dbGet("ni:sc"),
      dbGet("ni:mem"),dbGet("ni:settings"),dbGet("ni:weights")
    ]).then(function(v) {
      var loadedPortfolio = v[0]||[];
      var loadedWL = v[5]||DEFAULT_WL;
      var loadedMem = v[8]||{};
      var loadedSettings = v[9]?Object.assign({},DEFAULT_SETTINGS,v[9]):DEFAULT_SETTINGS;
      if(v[0]) setPortfolio(v[0]); if(v[1]) setTradeLog(v[1]); if(v[2]) setSignals(v[2]);
      if(v[3]) setMarket(v[3]); if(v[4]) setBrief(v[4]);
      if(v[5]) setWatchlist(v[5]); if(v[6]) setChat(v[6]); if(v[7]) setStockCache(v[7]);
      if(v[8]) setMemory(v[8]); if(v[9]) setSettings(loadedSettings);
      if(v[9] && v[9].exchange) setExchange(v[9].exchange);
      if(v[10]) setWeights(v[10]);
      if(!didScan.current) {
        didScan.current = true;
        setTimeout(function() { runScan(loadedWL, loadedMem, loadedSettings); }, 500);
      }
    });
  }, []);

  useEffect(function() {
    if(chatEnd.current) chatEnd.current.scrollIntoView({behavior:"smooth"});
  }, [chat, chatLoading]);
  useEffect(function() {
    if(sidebarEnd.current) sidebarEnd.current.scrollIntoView({behavior:"smooth"});
  }, [chat, chatLoading]);

  function addLog(msg, type, detail) {
    setLogs(function(p) {
      var entry = { ts:new Date().toISOString(), msg:msg, t:type||"info", detail:detail||null };
      return [entry].concat(p).slice(0, 60);
    });
  }
  function openAsk(prefill) { setSidebarOpen(true); if(prefill) { setChatInput(prefill); } }
  function showToast(msg,type) {
    var id=Date.now();
    setToasts(function(p){return p.concat([{id:id,msg:msg,t:type||"ok"}]);});
    setTimeout(function(){setToasts(function(p){return p.filter(function(x){return x.id!==id;});});},3000);
  }
  function saveSettings(updated) { setSettings(updated); dbSet("ni:settings",updated); }
  function saveExchange(ex) { setExchange(ex); saveSettings(Object.assign({},settings,{exchange:ex})); }

  function addToWatchlist(sym, source) {
    sym = sym.toUpperCase().trim();
    if(!sym || sym.length < 2) return false;
    var added = false;
    setWatchlist(function(prev) {
      if(prev.indexOf(sym) >= 0) return prev;
      added = true;
      var updated = prev.concat([sym]);
      dbSet("ni:wl", updated);
      // save source in memory
      setMemory(function(m) {
        var sources = m.wl_sources || {};
        sources[sym] = { source: source || "manual", added: new Date().toISOString() };
        var updated2 = Object.assign({}, m, { wl_sources: sources });
        dbSet("ni:mem", updated2);
        return updated2;
      });
      return updated;
    });
    return added;
  }

  function removeFromWatchlist(sym) {
    setWatchlist(function(prev) {
      var updated = prev.filter(function(s){return s!==sym;});
      dbSet("ni:wl", updated);
      return updated;
    });
    setMemory(function(m) {
      var sources = m.wl_sources || {};
      delete sources[sym];
      var updated = Object.assign({}, m, { wl_sources: sources });
      dbSet("ni:mem", updated);
      return updated;
    });
  }

  // -- MAIN SCAN ----------------------------------------------------------------
  function runScan(overrideWL, overrideMem, overrideSettings) {
    if(autoRunning) return;
    setAutoRunning(true);
    addLog("scan started", "info");
    var cfg = {search:true};
    var cfgN = {search:false};
    var lm = null;
    var acc = [];
    var currentWL = overrideWL || (watchlist.length > 0 ? watchlist : DEFAULT_WL);
    var currentMem = overrideMem || memory;
    var currentSettings = overrideSettings || settings;
    var discoveredSyms = [];

    // STEP 1: Fetch market - full movers list
    setScanPhase("market");
    var mktPrompt = "Fetch https://merolagani.com/LatestMarket.aspx and https://merolagani.com/MarketSummary.aspx?type=gainers and https://merolagani.com/MarketSummary.aspx?type=losers and https://merolagani.com/MarketSummary.aspx?type=turnover - get NEPSE index, top 20 gainers, top 20 losers, top 20 by turnover. Return ONLY valid JSON: {\"index\":0,\"change_pct\":0,\"turnover\":0,\"sentiment\":\"BULLISH\",\"gainers\":[{\"symbol\":\"\",\"pct\":0,\"ltp\":0}],\"losers\":[{\"symbol\":\"\",\"pct\":0,\"ltp\":0}],\"turnover\":[{\"symbol\":\"\",\"ltp\":0}],\"news\":[],\"ok\":true}";

    callAI(mktPrompt, cfg).then(function(raw) {
      var m = parseJ(raw);
      if(m && m.index) {
        lm = m; setMarket(m); dbSet("ni:mkt",m);
        addLog("NEPSE " + m.index + " " + (m.sentiment||""), "ok", {phase:"market", fetched:{index:m.index, change_pct:m.change_pct, sentiment:m.sentiment, gainers:(m.gainers||[]).slice(0,5), losers:(m.losers||[]).slice(0,5)}, source:"merolagani.com/LatestMarket.aspx"});
      } else {
        lm = {index:"?",change_pct:0,sentiment:"NEUTRAL",gainers:[],losers:[],turnover:[],news:[]};
        addLog("market parse failed - check merolagani.com", "err", {phase:"market", error:"JSON parse failed"});
      }
    }).catch(function(e) {
      lm = {index:"?",change_pct:0,sentiment:"NEUTRAL",gainers:[],losers:[],turnover:[],news:[]};
      addLog("market err: "+e.message, "err");
    })

    // STEP 2: Auto-discovery - pick best candidates from movers
    .then(function() {
      if(!currentSettings.discovery_on) return Promise.resolve();
      setScanPhase("discovery");
      addLog("auto-discovery running...", "api");

      var movers = [];
      var seen = {};
      var lists = [Array.isArray(lm.gainers)?lm.gainers:[], Array.isArray(lm.losers)?lm.losers:[], Array.isArray(lm.turnover)?lm.turnover:[]];
      lists.forEach(function(list) {
        list.forEach(function(item) {
          if(item.symbol && !seen[item.symbol]) {
            seen[item.symbol] = true;
            movers.push(item.symbol);
          }
        });
      });

      if(movers.length === 0) { addLog("no movers data for discovery", "err"); return Promise.resolve(); }

      var sectorFilter = "";
      var activeSectors = SECTORS.filter(function(s){ return currentSettings.sector_focus[s]; });
      if(activeSectors.length < SECTORS.length) {
        sectorFilter = " Focus on sectors: " + activeSectors.map(function(s){return SECTOR_LABELS[s];}).join(", ") + ".";
      }

      var depth = currentSettings.discovery_depth || 8;
      var existingStr = currentWL.join(", ");
      var moversStr = movers.slice(0,40).join(", ");

      var discPrompt = "From these NEPSE stocks with market activity today: " + moversStr + ". Already watching: " + existingStr + ". Pick the top " + depth + " stocks NOT already in the watchlist that have the strongest signal potential based on momentum and fundamentals." + sectorFilter + " Return ONLY valid JSON array of symbols: [\"SYM1\",\"SYM2\",\"SYM3\"]";

      return callAI(discPrompt, cfgN).then(function(raw) {
        var found = parseJ(raw);
        if(Array.isArray(found)) {
          discoveredSyms = found.filter(function(s){ return typeof s === "string" && currentWL.indexOf(s) < 0; }).slice(0, depth);
          addLog("discovered: " + discoveredSyms.join(", "), "ok", {phase:"discovery", symbols:discoveredSyms, from_movers:movers.slice(0,10)});
        } else {
          addLog("discovery parse failed", "err", {phase:"discovery", error:"could not parse symbol list"});
        }
      }).catch(function(e) { addLog("discovery err: "+e.message,"err"); });
    })

    // STEP 3: Scan watchlist + discovered stocks
    .then(function() {
      var safeWL = Array.isArray(currentWL) ? currentWL : DEFAULT_WL;
      var safeDisc = Array.isArray(discoveredSyms) ? discoveredSyms : [];
      var toScan = safeWL.concat(safeDisc.filter(function(s){ return safeWL.indexOf(s) < 0; }));
      addLog("scanning " + toScan.length + " stocks: " + toScan.join(", "), "info");

      var chain = Promise.resolve();
      toScan.forEach(function(sym) {
        chain = chain.then(function() {
          setScanSym(sym);
          setScanPhase("scanning");
          var safeDiscoveredSyms = Array.isArray(discoveredSyms) ? discoveredSyms : []; var isDiscovered = safeDiscoveredSyms.indexOf(sym) >= 0;
          addLog("fetching " + sym + (isDiscovered?" [discovered]":""), "api", {phase:"fetch", symbol:sym, url:"merolagani.com/CompanyDetail.aspx?symbol="+sym, source:isDiscovered?"auto-discovered":"watchlist"});

          var dp = "Fetch https://merolagani.com/CompanyDetail.aspx?symbol=" + sym + " - extract all data. Return ONLY valid JSON: {\"symbol\":\"" + sym + "\",\"price\":0,\"change_pct\":0,\"open\":0,\"high\":0,\"low\":0,\"volume\":0,\"week52_high\":0,\"week52_low\":0,\"avg120\":0,\"eps\":0,\"pe\":0,\"bv\":0,\"pbv\":0,\"div_pct\":0,\"yield\":0,\"sector\":\"\",\"news\":[],\"ok\":true}";

          return callAI(dp, cfg).then(function(raw) {
            var d = parseJ(raw);
            if(d && (d.price || d.symbol)) {
              if(!d.price) d.price = 0;
              addLog(sym + " Rs" + d.price + " EPS:" + d.eps + " PE:" + d.pe, "ok", {phase:"data", symbol:sym, price:d.price, change_pct:d.change_pct, eps:d.eps, pe:d.pe, bv:d.bv, div_pct:d.div_pct, week52_low:d.week52_low, week52_high:d.week52_high, avg120:d.avg120, sector:d.sector, volume:d.volume});
              var sc = {}; sc[sym] = d;
              setStockCache(function(prev){ var u=Object.assign({},prev,sc); dbSet("ni:sc",u); return u; });

              var prevSig = currentMem.signals_found && currentMem.signals_found.indexOf(sym) >= 0 ? " History: "+memory.signals_found : "";
              var wRates = weights && weights.overall && weights.overall.rate > 0 ? "Agent win rate: "+weights.overall.rate+"% from "+(weights.overall.wins+weights.overall.losses)+" trades. " : "";
              var sp2 = "NEPSE signal for " + sym + ". Real data: price Rs" + d.price + " (" + toPct(d.change_pct) + "), EPS " + d.eps + ", PE " + d.pe + ", BV Rs" + d.bv + ", 52wk Rs" + d.week52_low + "-Rs" + d.week52_high + ", 120d Rs" + d.avg120 + ", div " + d.div_pct + "%. NEPSE " + (lm?lm.index:"?") + " " + (lm?lm.sentiment:"") + ". " + wRates + prevSig + " Return ONLY JSON: {\"symbol\":\"" + sym + "\",\"signal\":\"BUY\",\"confidence\":\"HIGH\",\"price\":" + d.price + ",\"entry\":\"Rs X-Rs Y\",\"sl\":0,\"target\":0,\"hold\":\"2-4 weeks\",\"why\":\"2 sentences\",\"risk\":\"1 sentence\",\"action\":\"specific action\"}"

              return callAI(sp2, cfgN).then(function(sraw) {
                var sig = parseJ(sraw);
                if(sig && sig.symbol) {
                  var source = isDiscovered ? "discovered" : "watchlist";
                  var full = Object.assign({}, sig, {id:sym+Date.now(), at:new Date().toISOString(), live:d, source:source, outcome:"PENDING", exit_price:null, outcome_at:null});
                  acc.push(full);
                  addLog(sym + ": " + sig.signal + " " + sig.confidence + " | SL Rs" + sig.sl + " T Rs" + sig.target, "signal", {phase:"signal", symbol:sym, signal:sig.signal, confidence:sig.confidence, price:sig.price, entry:sig.entry, sl:sig.sl, target:sig.target, hold:sig.hold, why:sig.why, risk:sig.risk, action:sig.action, source:source});

                  // Update signals state immediately
                  setSignals(function(prev) {
                    var u = [full].concat(prev.filter(function(s){return s.symbol!==sym;})).slice(0,20);
                    dbSet("ni:sig",u); return u;
                  });

                  // Auto-add discovered stocks to watchlist if signal meets threshold
                  if(isDiscovered) {
                    var shouldAdd = false;
                    if(currentSettings.autoadd_threshold === "BUY" && sig.signal === "BUY") shouldAdd = true;
                    if(currentSettings.autoadd_threshold === "BUY_WATCH" && (sig.signal === "BUY" || sig.signal === "WATCH")) shouldAdd = true;
                    if(shouldAdd) {
                      var wasNew = addToWatchlist(sym, "discovered");
                      if(wasNew) {
                        addLog(sym + " auto-added to watchlist", "ok", {phase:"watchlist", symbol:sym, reason:"signal:"+sig.signal+" confidence:"+sig.confidence});
                        showToast(sym + " added to watchlist", "ok");
                      }
                    }
                  }
                }
              });
            }
          }).catch(function(e){ addLog(sym+" err: "+e.message,"err"); });
        }).then(function(){ return new Promise(function(r){setTimeout(r,300);}); });
      });

      return chain;
    })

    // STEP 4: Auto-remove stale stocks
    .then(function() {
      if(!currentSettings.autoremove_on) return;
      var openSymbols = portfolio.filter(function(p){return p.status==="OPEN";}).map(function(p){return p.symbol;});
      var scanCount = (currentMem.scan_count||0) + 1;
      var staleHistory = currentMem.stale_counts || {};
      var toRemove = [];

      var safeWatchlist = Array.isArray(watchlist) ? watchlist : [];
      safeWatchlist.forEach(function(sym) {
        if(openSymbols.indexOf(sym) >= 0) return; // never remove held stocks
        var sig = acc.find(function(s){return s.symbol===sym;});
        if(sig && (sig.signal === "NEUTRAL" || sig.signal === "AVOID")) {
          staleHistory[sym] = (staleHistory[sym]||0) + 1;
          if(staleHistory[sym] >= currentSettings.autoremove_after) {
            toRemove.push(sym);
            delete staleHistory[sym];
            addLog(sym + " auto-removed (" + settings.autoremove_after + " stale scans)", "info");
          }
        } else if(sig && (sig.signal === "BUY" || sig.signal === "WATCH")) {
          staleHistory[sym] = 0; // reset stale count on good signal
        }
      });

      if(toRemove.length > 0) {
        setWatchlist(function(prev) {
          var updated = prev.filter(function(s){return toRemove.indexOf(s)<0;});
          dbSet("ni:wl",updated); return updated;
        });
      }

      setMemory(function(m) {
        var updated = Object.assign({},m,{
          scan_count: scanCount,
          last_scan: new Date().toISOString(),
          signals_found: acc.map(function(s){return s.symbol+":"+s.signal;}).join(", "),
          stale_counts: staleHistory
        });
        dbSet("ni:mem",updated); return updated;
      });
    })

    // STEP 5: Generate brief
    .then(function() {
      setScanPhase("brief");
      var openP = portfolio.filter(function(p){return p.status==="OPEN";});
      var buys = acc.filter(function(s){return s.signal==="BUY";});
      var mktStr = lm ? "NEPSE "+lm.index+" "+lm.sentiment : "market unavailable";
      var portStr = openP.length ? openP.map(function(p){return p.symbol+" "+p.qty+"u@Rs"+p.price;}).join(", ") : "no open positions";
      var sigStr = acc.length ? acc.map(function(s){return s.symbol+":"+s.signal+"@Rs"+s.price;}).join(", ") : "no signals";
      var buyStr = buys.length ? buys.map(function(s){return s.symbol+" Rs"+s.price+" ("+s.confidence+")";}).join(", ") : "none";
      var bpStr = "Write a sharp NEPSE trading brief. Market: "+mktStr+". Portfolio: "+portStr+". Signals scanned: "+sigStr+". Best buy opportunities: "+buyStr+". Respond with ONLY this JSON, no other text: {\"headline\":\"one punchy line about today\",\"market_note\":\"one line on NEPSE conditions\",\"portfolio_flag\":\"one line if portfolio needs attention, else empty string\",\"top_action\":\"the single most important action today\",\"mood\":\"POSITIVE\"}";
      return callAI(bpStr, cfgN).then(function(braw) {
        addLog("generating brief...", "api", {phase:"brief", signals_count:acc.length, buys:buys.length});
        var b = parseJ(braw);
        if(b && b.headline) {
          setBrief(b); dbSet("ni:brief",b);
          addLog("brief ready", "ok", {phase:"brief", headline:b.headline, market_note:b.market_note, top_action:b.top_action, mood:b.mood});
        } else {
          // Fallback brief from signals
          var fallback = {
            headline: buys.length ? "Buy opportunities: "+buys.map(function(s){return s.symbol;}).join(", ") : "Scan complete - "+acc.length+" signals",
            market_note: mktStr,
            portfolio_flag: openP.length ? openP.length+" positions open" : "",
            top_action: buys.length ? "Review "+buys[0].symbol+" BUY signal" : "No strong buys today",
            mood: buys.length > 0 ? "POSITIVE" : "NEUTRAL"
          };
          setBrief(fallback); dbSet("ni:brief",fallback);
          addLog("brief fallback used","info");
        }
      }).catch(function(e){
        addLog("brief err: "+e.message,"err");
        var fallback = {headline:"Scan complete - "+acc.length+" signals found",market_note:mktStr,portfolio_flag:"",top_action:buys.length?"Review "+buys[0].symbol:"No strong buys",mood:"NEUTRAL"};
        setBrief(fallback); dbSet("ni:brief",fallback);
      });
    })

    .then(function() { setScanSym(""); setScanPhase(""); setAutoRunning(false); addLog("scan complete _ " + acc.length + " signals, " + acc.filter(function(s){return s.signal==="BUY";}).length + " BUY", "ok", {phase:"complete", total:acc.length, buys:acc.filter(function(s){return s.signal==="BUY";}).length, duration:""}); })
    .catch(function(e) { addLog("scan failed: "+e.message,"err"); setScanSym(""); setScanPhase(""); setAutoRunning(false); });
  }

  // -- open stock overlay ----------------------------------------------------
  function openStock(sym) {
    setOvSym(sym); setOvData(null); setOvAnalysis(""); setOvSig(null); setOvLoading(true);
    var cfg={search:true}; var cfgN={search:false};
    callAI("Fetch https://merolagani.com/CompanyDetail.aspx?symbol="+sym+" - extract all data. Return ONLY valid JSON: {\"symbol\":\""+sym+"\",\"price\":0,\"change_pct\":0,\"open\":0,\"high\":0,\"low\":0,\"volume\":0,\"week52_high\":0,\"week52_low\":0,\"avg120\":0,\"eps\":0,\"pe\":0,\"bv\":0,\"pbv\":0,\"div_pct\":0,\"yield\":0,\"sector\":\"\",\"news\":[],\"ok\":true}", cfg)
    .then(function(raw) {
      var d = parseJ(raw);
      if(d && d.price) {
        setOvData(d);
        var sc={}; sc[sym]=d;
        setStockCache(function(prev){var u=Object.assign({},prev,sc); dbSet("ni:sc",u); return u;});
        var held = portfolio.find(function(p){return p.symbol===sym&&p.status==="OPEN";});
        var heldStr = held ? " HOLDING: "+held.qty+"u@Rs"+held.price+" BE Rs"+held.be.toFixed(2)+" "+daysAgo(held.date)+"d" : "";
        return Promise.all([
          callAI("Full NEPSE analysis of "+sym+". Max 180 words. Direct. Live: Rs"+d.price+"("+toPct(d.change_pct)+") 52wk Rs"+d.week52_low+"-Rs"+d.week52_high+" 120d Rs"+d.avg120+" EPS "+d.eps+" PE "+d.pe+" BV Rs"+d.bv+" Div "+d.div_pct+"%"+heldStr+". Cover: why price here, EPS/PE value, technical vs range, main risk, verdict.", cfgN),
          callAI("Signal for "+sym+" price Rs"+d.price+". Return ONLY JSON: {\"symbol\":\""+sym+"\",\"signal\":\"BUY\",\"confidence\":\"MEDIUM\",\"price\":"+d.price+",\"entry\":\"\",\"sl\":0,\"target\":0,\"why\":\"\",\"action\":\"\"}", cfgN)
        ]).then(function(results) {
          setOvAnalysis(results[0]);
          var sig = parseJ(results[1]);
          if(sig&&sig.symbol) {
            var full = Object.assign({},sig,{id:sym+Date.now(),at:new Date().toISOString(),live:d,source:"overlay"});
            setOvSig(full);
            setSignals(function(prev){var u=[full].concat(prev.filter(function(s){return s.symbol!==sym;})).slice(0,20); dbSet("ni:sig",u); return u;});
          }
        });
      }
    }).catch(function(e){setOvAnalysis("Error: "+e.message);}).then(function(){setOvLoading(false);});
  }

  // -- trade functions -------------------------------------------------------
  function logBuy(sig) {
    var q=parseFloat(buyQty), p=sig.price||0;
    if(!q||!p||!buyReason){showToast("Basis required","err");return;}
    var c=calcC("BUY",q,p,0,0);
    var trade={id:"T"+Date.now(),date:new Date().toISOString(),symbol:sig.symbol,action:"BUY",qty:q,price:p,tot:c.tot,be:c.be,net:c.net,sl:parseFloat(buySL)||sig.sl||null,target:sig.target||null,basis:buyReason,status:"OPEN"};
    var updP=portfolio.concat([trade]), updL=[trade].concat(tradeLog);
    setPortfolio(updP); dbSet("ni:p",updP); setTradeLog(updL); dbSet("ni:tl",updL);
    addToWatchlist(sig.symbol, "holding");
    setBuyTarget(null); setBuyQty(""); setBuySL(""); setBuyReason("");
    showToast("BUY "+sig.symbol+" Rs"+p); setTab("positions");
  }

  function logSell(pos) {
    var sp=parseFloat(sellPrice);
    if(!sp||!sellReason){showToast("Price and reason required","err");return;}
    var hd=daysAgo(pos.date), c=calcC("SELL",pos.qty,sp,pos.price,hd);
    var trade={id:"T"+Date.now(),date:new Date().toISOString(),symbol:pos.symbol,action:"SELL",qty:pos.qty,price:sp,tot:c.tot,npl:c.npl,gpl:c.gpl,cgt:c.cgt,net:c.net,buyPrice:pos.price,holdDays:hd,basis:sellReason,status:"CLOSED",matchId:pos.id};
    var updP=portfolio.map(function(p){return p.id===pos.id?Object.assign({},p,{status:"CLOSED"}):p;});
    var updL=[trade].concat(tradeLog);
    setPortfolio(updP); dbSet("ni:p",updP); setTradeLog(updL); dbSet("ni:tl",updL);
    // Record outcome on matching signal
    var outcome = c.npl >= 0 ? "WIN" : "LOSS";
    setSignals(function(prev) {
      var updS = prev.map(function(s) {
        if(s.symbol === pos.symbol && s.outcome === "PENDING") {
          return Object.assign({}, s, {outcome:outcome, exit_price:sp, outcome_at:new Date().toISOString(), return_pct:((sp-pos.price)/pos.price*100).toFixed(2)});
        }
        return s;
      });
      dbSet("ni:sig", updS);
      // Update weights
      var sigForSym = prev.find(function(s){return s.symbol===pos.symbol&&s.outcome==="PENDING";});
      if(sigForSym) {
        setWeights(function(w) {
          var updated = JSON.parse(JSON.stringify(w||{}));
          var sector = (sigForSym.live&&sigForSym.live.sector) ? sigForSym.live.sector.toLowerCase().replace(/\s+/g,"-") : "unknown";
          var key = sigForSym.signal+"_"+sector;
          if(!updated.signal_sector) updated.signal_sector = {};
          if(!updated.signal_sector[key]) updated.signal_sector[key] = {wins:0,losses:0,rate:0,avg_return:0};
          if(outcome==="WIN") updated.signal_sector[key].wins++;
          else updated.signal_sector[key].losses++;
          var entry = updated.signal_sector[key];
          var total = entry.wins + entry.losses;
          entry.rate = total > 0 ? Math.round((entry.wins/total)*100) : 0;
          if(!updated.overall) updated.overall = {wins:0,losses:0,rate:0};
          if(outcome==="WIN") updated.overall.wins++; else updated.overall.losses++;
          var ot = updated.overall.wins + updated.overall.losses;
          updated.overall.rate = ot > 0 ? Math.round((updated.overall.wins/ot)*100) : 0;
          updated.last_updated = new Date().toISOString();
          dbSet("ni:weights", updated);
          return updated;
        });
      }
      return updS;
    });
    setSellTarget(null); setSellPrice(""); setSellReason("");
    showToast("SELL "+pos.symbol+" "+signed(c.npl)+(outcome==="WIN"?" WIN":" LOSS"), c.npl>=0?"ok":"err");
    setTab("positions");
  }

  // -- chat ------------------------------------------------------------------
  function sendChat(text) {
    var msg=(text||chatInput||"").trim();
    if(!msg||chatLoading) return;
    setChatInput("");
    var openP=portfolio.filter(function(p){return p.status==="OPEN";});
    var unrealised=openP.reduce(function(tot,p){
      var live=stockCache[p.symbol]; var sigL=signals.find(function(s){return s.symbol===p.symbol&&s.live;});
      var lp=live?live.price:(sigL&&sigL.live?sigL.live.price:null);
      return tot+(lp?(lp-p.price)*p.qty:0);
    },0);
    var memStr=memory.last_scan
      ?"Scan #"+(memory.scan_count||0)+" on "+memory.last_scan.slice(0,10)+". Last signals: "+(memory.signals_found||"none")+"."
      :"No previous scans.";
    var alertStr=alerts.length?"ALERTS: "+alerts.map(function(a){return a.msg;}).join("; ")+".":"";
    var portStr2 = openP.length ? openP.map(function(p){return p.symbol+" "+p.qty+"u@Rs"+p.price+" "+daysAgo(p.date)+"d"+(p.sl?" SL"+p.sl:" NO-SL")+(p.target?" T"+p.target:"");}).join(", ") : "empty";
    var sigStr2 = signals.slice(0,6).map(function(s){return s.symbol+":"+s.signal+"@Rs"+(s.price||0);}).join(", ");
    var mktStr2 = market ? "NEPSE "+market.index+" "+market.sentiment+" "+toPct(market.change_pct) : "unknown";
    var sys = "NEPSE advisor. Portfolio ("+openP.length+" open, unrealised "+(unrealised>=0?"+":"")+toRs(unrealised)+"): "+portStr2+". Signals: "+sigStr2+". Market: "+mktStr2+". Memory: "+memStr+" "+alertStr+" Watchlist: "+watchlist.join(", ")+". Charges: broker 0.4% min Rs10, SEBON 0.0015%, DP Rs25, CGT 7.5%/5%. Direct, max 5 lines. Question: "+msg;
    var newChat=chat.concat([{role:"user",content:msg,ts:new Date().toISOString()}]);
    setChat(newChat); dbSet("ni:chat",newChat); setChatLoading(true);
    callAI(sys,{search:true}).then(function(reply) {
      var final=newChat.concat([{role:"assistant",content:reply,ts:new Date().toISOString()}]);
      setChat(final); dbSet("ni:chat",final); setChatLoading(false);
    }).catch(function(e) {
      var final=newChat.concat([{role:"assistant",content:"Error: "+e.message,ts:new Date().toISOString()}]);
      setChat(final); dbSet("ni:chat",final); setChatLoading(false);
    });
  }

  // -- derived ---------------------------------------------------------------
  var openPos=portfolio.filter(function(p){return p.status==="OPEN";});
  var closedSells=tradeLog.filter(function(t){return t.action==="SELL";});
  var realisedPL=closedSells.reduce(function(s,t){return s+(t.npl||0);},0);
  var buySigCount=signals.filter(function(s){return s.signal==="BUY";}).length;
  var noSLCount=openPos.filter(function(p){return !p.sl&&daysAgo(p.date)>3;}).length;
  // SL/Target alerts
  var alerts=openPos.reduce(function(arr,p){
    var live=stockCache[p.symbol];
    var sigLive=signals.find(function(s){return s.symbol===p.symbol&&s.live;});
    var lp=live?live.price:(sigLive&&sigLive.live?sigLive.live.price:null);
    if(!lp) return arr;
    if(p.sl && lp<=p.sl) arr.push({symbol:p.symbol,type:"SL_BREACH",price:lp,level:p.sl,msg:p.symbol+" Rs"+lp+" hit stop-loss Rs"+p.sl});
    if(p.target && lp>=p.target) arr.push({symbol:p.symbol,type:"TARGET_HIT",price:lp,level:p.target,msg:p.symbol+" Rs"+lp+" reached target Rs"+p.target});
    return arr;
  },[]);

  // -- style helpers ---------------------------------------------------------
  function card(leftColor, extra) {
    var base = {background:"#0b0e16",border:"1px solid #1e2840",borderLeft:"2px solid "+(leftColor||"#1e2840"),borderRadius:10,padding:"14px 16px",marginBottom:10};
    return extra ? Object.assign({},base,extra) : base;
  }
  function btn(color, sm) {
    return {padding:sm?"4px 10px":"6px 14px",borderRadius:7,border:"1px solid "+(color||"#1e2840"),background:"transparent",color:color||"#4a5568",fontSize:sm?10:11,cursor:"pointer",fontFamily:"IBM Plex Mono,monospace",letterSpacing:".02em"};
  }
  function sbox(label, value, color) {
    return (
      <div style={{background:"#07090e",borderRadius:7,padding:"6px 10px",border:"1px solid #141824"}}>
        <div style={{fontSize:8,color:"#2a3550",textTransform:"uppercase",letterSpacing:".08em",marginBottom:3}}>{label}</div>
        <div style={{fontSize:12,fontWeight:500,color:color||"#c8d4e8",fontFamily:"IBM Plex Mono,monospace"}}>{value||"-"}</div>
      </div>
    );
  }
  function ghost(w) {
    return <div style={{height:10,background:"#1e2840",borderRadius:4,width:(w||70)+"%",animation:"_pulse 1.6s ease infinite",marginBottom:8}}/>;
  }
  function SectionHeader(props) {
    return (
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:props.mb||14}}>
        <div style={{width:3,height:16,background:props.color||"#3b82f6",borderRadius:2}}/>
        <span style={{fontSize:13,fontWeight:600,color:"#e2e8f0",fontFamily:"Inter,sans-serif",letterSpacing:"-.01em"}}>{props.title}</span>
        {props.sub&&<span style={{fontSize:10,color:"#4a5568",marginLeft:2}}>{props.sub}</span>}
      </div>
    );
  }
  function ToggleBtn(props) {
    var onStyle = {padding:"5px 18px",borderRadius:20,border:"1px solid #10b981",fontSize:11,cursor:"pointer",fontFamily:"IBM Plex Mono,monospace",minWidth:52,background:"#10b981",color:"#fff"};
    var offStyle = {padding:"5px 18px",borderRadius:20,border:"1px solid #1e2840",fontSize:11,cursor:"pointer",fontFamily:"IBM Plex Mono,monospace",minWidth:52,background:"#0b0e16",color:"#4a5568"};
    return <button onClick={props.onClick} style={props.on?onStyle:offStyle}>{props.on?"ON":"OFF"}</button>;
  }
  function SegBtn(props) {
    return (
      <div style={{display:"flex",gap:3,background:"#07090e",padding:3,borderRadius:8,border:"1px solid #1e2840"}}>
        {props.options.map(function(o) {
          var active = props.value===(o[0]||o);
          var aStyle = {padding:"4px 10px",borderRadius:6,border:"1px solid #3b82f6",fontSize:10,cursor:"pointer",fontFamily:"IBM Plex Mono,monospace",background:"#3b82f622",color:"#3b82f6"};
          var iStyle = {padding:"4px 10px",borderRadius:6,border:"1px solid #1e2840",fontSize:10,cursor:"pointer",fontFamily:"IBM Plex Mono,monospace",background:"transparent",color:"#4a5568"};
          return <button key={o[0]||o} onClick={function(){props.onChange(o[0]||o);}} style={active?aStyle:iStyle}>{o[1]||o}</button>;
        })}
      </div>
    );
  }

  // -- tabs ------------------------------------------------------------------
  var TAB_ICONS = {today:"[o]", positions:"[=]", signals:"[!]", watchlist:"[*]", settings:"[-]"};
  var TABS = [
    {k:"today", label:"Today", icon:"o"},
    {k:"positions", label:"Positions"+(noSLCount>0?" !":""), icon:"="},
    {k:"signals", label:"Signals"+(buySigCount>0?" "+buySigCount:""), icon:"!"},
    {k:"watchlist", label:"Watch "+watchlist.length, icon:"*"}
  ];

  // ---------------------------------------------------------------------------
  return (
    <div style={{background:"#07090e",minHeight:"100vh",display:"flex",flexDirection:"column",fontFamily:"IBM Plex Mono,monospace",color:"#c8d4e8",fontSize:12}}>

      {/* toasts */}
      <div style={{position:"fixed",top:10,left:"50%",transform:"translateX(-50%)",zIndex:400,display:"flex",flexDirection:"column",gap:4,pointerEvents:"none",alignItems:"center"}}>
        {toasts.map(function(t) {
          var tc=t.t==="err"?"#ef4444":t.t==="info"?"#3b82f6":"#10b981";
          return <div key={t.id} style={{padding:"6px 14px",borderRadius:20,background:"#0d1018",border:"1px solid "+tc+"44",color:tc,fontSize:10,fontFamily:"Inter,sans-serif",whiteSpace:"nowrap"}}>{t.msg}</div>;
        })}
      </div>

      {/* HEADER */}
      <div style={{background:"#07090e",borderBottom:"1px solid #141824",padding:"0 16px",flexShrink:0}}>
        {/* top bar */}
        <div style={{display:"flex",alignItems:"center",gap:10,height:44,borderBottom:"1px solid #0f1420"}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:7,height:7,borderRadius:"50%",background:autoRunning?"#f59e0b":"#10b981",animation:autoRunning?"_dot 1s ease infinite":"none"}}/>
            <span style={{fontSize:14,fontWeight:600,color:"#e2e8f0",letterSpacing:"-.01em",fontFamily:"Inter,sans-serif"}}>{exchange}</span>
            <span style={{fontSize:10,color:"#2a3550",fontFamily:"Inter,sans-serif"}}>Intelligence</span>
          </div>
          {market ? (
            <div style={{display:"flex",alignItems:"center",gap:6,padding:"3px 10px",background:"#0b0e16",border:"1px solid #1e2840",borderRadius:6}}>
              <span style={{fontSize:12,fontWeight:600,color:"#e2e8f0",fontFamily:"IBM Plex Mono,monospace"}}>{market.index}</span>
              <span style={{fontSize:10,color:market.change_pct>=0?"#10b981":"#ef4444",fontFamily:"IBM Plex Mono,monospace"}}>{toPct(market.change_pct)}</span>
              <span style={{fontSize:9,padding:"1px 6px",borderRadius:3,background:market.sentiment==="BULLISH"?"#10b98122":market.sentiment==="BEARISH"?"#ef444422":"#f59e0b22",color:market.sentiment==="BULLISH"?"#10b981":market.sentiment==="BEARISH"?"#ef4444":"#f59e0b"}}>{market.sentiment}</span>
            </div>
          ) : (
            <div style={{padding:"3px 10px",background:"#0b0e16",border:"1px solid #1e2840",borderRadius:6}}>
              <span style={{fontSize:9,color:"#4a5568"}}>{autoRunning?"scanning "+scanPhase+(scanSym?" "+scanSym:"")+"...":signals.length+" signals ready"}</span>
            </div>
          )}
          <div style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center"}}>
            {openPos.length>0&&<span style={{fontSize:10,color:"#4a5568",fontFamily:"Inter,sans-serif"}}>{openPos.length+" open"}</span>}
            {realisedPL!==0&&<span style={{fontSize:10,fontWeight:500,color:realisedPL>=0?"#10b981":"#ef4444",fontFamily:"IBM Plex Mono,monospace"}}>{signed(realisedPL)}</span>}
            <button onClick={function(){setShowLog(function(v){return !v;});}} style={{padding:"3px 8px",borderRadius:5,border:"1px solid #1e2840",background:showLog?"#1e2840":"transparent",color:showLog?"#e2e8f0":"#4a5568",fontSize:9,cursor:"pointer",fontFamily:"IBM Plex Mono,monospace",display:"flex",alignItems:"center",gap:4}}>{autoRunning&&<span style={{width:4,height:4,borderRadius:"50%",background:"#f59e0b",animation:"_dot 1s ease infinite",display:"inline-block"}}/>}{"activity"}</button>
          </div>
        </div>
        {/* nav bar */}
        <div style={{display:"flex",alignItems:"center",height:38}}>
          <div style={{display:"flex",flex:1,gap:0}}>
            {TABS.map(function(t) {
              var active=tab===t.k;
              return (
                <button key={t.k} onClick={function(){setTab(t.k);}} style={{padding:"0 14px",height:38,border:"none",background:"none",cursor:"pointer",fontSize:12,fontWeight:active?500:400,fontFamily:"Inter,sans-serif",color:active?"#e2e8f0":"#4a5568",borderBottom:active?"2px solid #3b82f6":"2px solid transparent",whiteSpace:"nowrap",transition:"color .15s,border-color .15s",display:"flex",alignItems:"center",gap:5}}>
                  {t.label}
                  {t.k==="signals"&&buySigCount>0&&<span style={{fontSize:9,padding:"1px 5px",borderRadius:10,background:"#10b98122",color:"#10b981",fontFamily:"IBM Plex Mono,monospace"}}>{buySigCount}</span>}
                  {t.k==="positions"&&noSLCount>0&&<span style={{fontSize:9,padding:"1px 5px",borderRadius:10,background:"#ef444422",color:"#ef4444",fontFamily:"IBM Plex Mono,monospace"}}>!</span>}
                </button>
              );
            })}
          </div>
          {/* divider + utility */}
          <div style={{width:1,height:20,background:"#1e2840",margin:"0 6px"}}/>
          <button onClick={function(){setTab("settings");}} title="Settings" style={{padding:"0 10px",height:38,border:"none",background:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",borderBottom:tab==="settings"?"2px solid #3b82f6":"2px solid transparent",transition:"all .15s"}}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={tab==="settings"?"#e2e8f0":"#4a5568"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
          <button onClick={function(){setSidebarOpen(function(v){return !v;});}} style={{display:"flex",alignItems:"center",gap:5,padding:"0 12px",height:34,border:"1px solid "+(sidebarOpen?"#3b82f6":"#1e2840"),borderRadius:7,background:sidebarOpen?"#3b82f610":"transparent",cursor:"pointer",marginLeft:4,transition:"all .15s"}}>
            <span style={{fontSize:11,color:sidebarOpen?"#3b82f6":"#4a5568",fontFamily:"Inter,sans-serif",fontWeight:500}}>Ask</span>
            <span style={{fontSize:10,color:sidebarOpen?"#3b82f6":"#2a3550"}}>{sidebarOpen?"x":""}</span>
          </button>
        </div>
      </div>

      {/* ACTIVITY PANEL */}
      {showLog&&(
        <div style={{background:"#060810",borderBottom:"1px solid #141824",maxHeight:320,overflowY:"auto",flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 16px",borderBottom:"1px solid #0f1420",position:"sticky",top:0,background:"#060810",zIndex:10}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <div style={{width:5,height:5,borderRadius:"50%",background:autoRunning?"#f59e0b":"#2a3550",animation:autoRunning?"_dot 1s ease infinite":"none"}}/>
              <span style={{fontSize:10,fontWeight:500,color:"#e2e8f0",fontFamily:"Inter,sans-serif"}}>Agent Activity</span>
              <span style={{fontSize:9,color:"#2a3550",fontFamily:"IBM Plex Mono,monospace"}}>{logs.length+" entries"}</span>
            </div>
            <button onClick={function(){setLogs([]);}} style={{fontSize:9,color:"#2a3550",background:"none",border:"1px solid #1e2840",borderRadius:3,padding:"2px 7px",cursor:"pointer",fontFamily:"IBM Plex Mono,monospace"}}>clear</button>
          </div>
          {logs.length===0&&<div style={{fontSize:10,color:"#2a3550",padding:"12px 16px",fontFamily:"IBM Plex Mono,monospace"}}>no activity yet _ scan will populate this</div>}
          {logs.map(function(l,i) {
            var lc = l.t==="ok"?"#10b981":l.t==="err"?"#ef4444":l.t==="signal"?"#f59e0b":l.t==="api"?"#3b82f6":l.t==="info"?"#8899b4":"#4a5568";
            var phaseIcon = l.detail&&l.detail.phase==="market"?"M":l.detail&&l.detail.phase==="discovery"?"D":l.detail&&l.detail.phase==="fetch"?"F":l.detail&&l.detail.phase==="data"?"R":l.detail&&l.detail.phase==="signal"?"S":l.detail&&l.detail.phase==="brief"?"B":l.detail&&l.detail.phase==="complete"?"C":".";
            var isExpanded = logExpanded[i];
            var hasDetail = l.detail && Object.keys(l.detail).length > 1;
            return (
              <div key={i} style={{borderTop:i>0?"1px solid #0a0c14":"none"}}>
                <div onClick={function(){if(hasDetail){setLogExpanded(function(prev){var u=Object.assign({},prev); u[i]=!u[i]; return u;});}}} style={{display:"flex",gap:8,padding:"5px 16px",alignItems:"flex-start",cursor:hasDetail?"pointer":"default",background:isExpanded?"#0b0e16":"transparent",transition:"background .1s"}}>
                  <span style={{color:"#2a3550",flexShrink:0,fontFamily:"IBM Plex Mono,monospace",fontSize:9,marginTop:1}}>{new Date(l.ts).toLocaleTimeString("en-NP",{hour12:false,hour:"2-digit",minute:"2-digit",second:"2-digit"})}</span>
                  <span style={{width:14,height:14,borderRadius:3,background:lc+"22",color:lc,fontSize:8,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontFamily:"IBM Plex Mono,monospace",fontWeight:600}}>{phaseIcon}</span>
                  <span style={{fontSize:10,color:lc,fontFamily:"IBM Plex Mono,monospace",flex:1,lineHeight:1.4}}>{l.msg}</span>
                  {hasDetail&&<span style={{fontSize:8,color:"#2a3550",flexShrink:0,marginTop:1}}>{isExpanded?"^":"v"}</span>}
                </div>
                {isExpanded&&l.detail&&(
                  <div style={{padding:"8px 16px 8px 38px",background:"#0b0e16",borderTop:"1px solid #0f1420"}}>
                    {l.detail.phase==="market"&&(
                      <div>
                        <div style={{fontSize:9,color:"#4a5568",marginBottom:4,fontFamily:"IBM Plex Mono,monospace"}}>{"source: "+l.detail.source}</div>
                        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:4,marginBottom:6}}>
                          {[["Index",l.detail.fetched&&l.detail.fetched.index,"#e2e8f0"],["Change",l.detail.fetched&&(l.detail.fetched.change_pct>=0?"+":"")+l.detail.fetched&&l.detail.fetched.change_pct+"%",l.detail.fetched&&l.detail.fetched.change_pct>=0?"#10b981":"#ef4444"],["Sentiment",l.detail.fetched&&l.detail.fetched.sentiment,l.detail.fetched&&l.detail.fetched.sentiment==="BULLISH"?"#10b981":l.detail.fetched&&l.detail.fetched.sentiment==="BEARISH"?"#ef4444":"#f59e0b"]].map(function(item){return <div key={item[0]} style={{background:"#07090e",borderRadius:4,padding:"4px 8px"}}><div style={{fontSize:7,color:"#2a3550",marginBottom:1}}>{item[0]}</div><div style={{fontSize:10,fontWeight:500,color:item[2]||"#c8d4e8",fontFamily:"IBM Plex Mono,monospace"}}>{item[1]||"-"}</div></div>;})}
                        </div>
                        {l.detail.fetched&&l.detail.fetched.gainers&&l.detail.fetched.gainers.length>0&&(
                          <div>
                            <div style={{fontSize:8,color:"#2a3550",marginBottom:3,fontFamily:"IBM Plex Mono,monospace"}}>TOP GAINERS</div>
                            <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                              {l.detail.fetched.gainers.map(function(g){return <span key={g.symbol} style={{fontSize:9,color:"#10b981",background:"#10b98110",padding:"2px 6px",borderRadius:3,fontFamily:"IBM Plex Mono,monospace"}}>{g.symbol+" +"+(g.pct||0).toFixed(1)+"%"}</span>;})}</div>
                          </div>
                        )}
                      </div>
                    )}
                    {l.detail.phase==="discovery"&&(
                      <div>
                        <div style={{fontSize:9,color:"#4a5568",marginBottom:4,fontFamily:"IBM Plex Mono,monospace"}}>{"scored from movers: "+(l.detail.from_movers||[]).join(", ")}</div>
                        <div style={{fontSize:9,color:"#a78bfa",fontFamily:"IBM Plex Mono,monospace"}}>{"selected: "+(l.detail.symbols||[]).join(", ")}</div>
                      </div>
                    )}
                    {(l.detail.phase==="data")&&(
                      <div>
                        <div style={{fontSize:9,color:"#4a5568",marginBottom:6,fontFamily:"IBM Plex Mono,monospace"}}>{"url: merolagani.com/CompanyDetail.aspx?symbol="+l.detail.symbol}</div>
                        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:4,marginBottom:4}}>
                          {[["Price","Rs "+l.detail.price,"#e2e8f0"],["Change",toPct(l.detail.change_pct),l.detail.change_pct>=0?"#10b981":"#ef4444"],["EPS",l.detail.eps,"#c8d4e8"],["PE",l.detail.pe,"#c8d4e8"],["BV","Rs "+l.detail.bv,"#c8d4e8"],["Div",l.detail.div_pct+"%","#c8d4e8"],["52wk L","Rs "+l.detail.week52_low,"#c8d4e8"],["52wk H","Rs "+l.detail.week52_high,"#c8d4e8"],["120d avg","Rs "+l.detail.avg120,"#c8d4e8"],["Volume",l.detail.volume,"#c8d4e8"],["Sector",l.detail.sector||"-","#a78bfa"]].map(function(item){return <div key={item[0]} style={{background:"#07090e",borderRadius:4,padding:"4px 8px"}}><div style={{fontSize:7,color:"#2a3550",marginBottom:1}}>{item[0]}</div><div style={{fontSize:10,fontWeight:500,color:item[2],fontFamily:"IBM Plex Mono,monospace"}}>{item[1]||"-"}</div></div>;})}
                        </div>
                      </div>
                    )}
                    {l.detail.phase==="signal"&&(
                      <div>
                        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:4,marginBottom:6}}>
                          {[["Signal",l.detail.signal,l.detail.signal==="BUY"?"#10b981":l.detail.signal==="SELL"?"#ef4444":l.detail.signal==="WATCH"?"#f59e0b":"#4a5568"],["Confidence",l.detail.confidence,l.detail.confidence==="HIGH"?"#10b981":l.detail.confidence==="MEDIUM"?"#f59e0b":"#4a5568"],["Entry",l.detail.entry||"-","#c8d4e8"],["Stop Loss","Rs "+l.detail.sl,"#ef4444"],["Target","Rs "+l.detail.target,"#10b981"],["Hold",l.detail.hold||"-","#c8d4e8"]].map(function(item){return <div key={item[0]} style={{background:"#07090e",borderRadius:4,padding:"4px 8px"}}><div style={{fontSize:7,color:"#2a3550",marginBottom:1}}>{item[0]}</div><div style={{fontSize:10,fontWeight:500,color:item[2],fontFamily:"IBM Plex Mono,monospace"}}>{item[1]||"-"}</div></div>;})}
                        </div>
                        <div style={{fontSize:9,color:"#8899b4",lineHeight:1.6,fontFamily:"Inter,sans-serif",marginBottom:3}}>{l.detail.why}</div>
                        {l.detail.risk&&<div style={{fontSize:9,color:"#f59e0b",fontFamily:"Inter,sans-serif",marginBottom:2}}>{"risk: "+l.detail.risk}</div>}
                        {l.detail.action&&<div style={{fontSize:9,color:"#3b82f6",fontFamily:"Inter,sans-serif"}}>{"-> "+l.detail.action}</div>}
                      </div>
                    )}
                    {l.detail.phase==="brief"&&l.detail.headline&&(
                      <div>
                        <div style={{fontSize:10,fontWeight:500,color:"#e2e8f0",marginBottom:4,fontFamily:"Inter,sans-serif"}}>{l.detail.headline}</div>
                        {l.detail.market_note&&<div style={{fontSize:9,color:"#4a5568",marginBottom:2,fontFamily:"Inter,sans-serif"}}>{l.detail.market_note}</div>}
                        {l.detail.top_action&&<div style={{fontSize:9,color:"#3b82f6",fontFamily:"Inter,sans-serif"}}>{"-> "+l.detail.top_action}</div>}
                      </div>
                    )}
                    {l.detail.phase==="complete"&&(
                      <div style={{display:"flex",gap:12}}>
                        <span style={{fontSize:9,color:"#4a5568",fontFamily:"IBM Plex Mono,monospace"}}>{"total signals: "+l.detail.total}</span>
                        <span style={{fontSize:9,color:"#10b981",fontFamily:"IBM Plex Mono,monospace"}}>{"BUY: "+l.detail.buys}</span>
                        <span style={{fontSize:9,color:"#4a5568",fontFamily:"IBM Plex Mono,monospace"}}>{"NEUTRAL/AVOID: "+(l.detail.total-l.detail.buys)}</span>
                      </div>
                    )}
                    {l.detail.error&&<div style={{fontSize:9,color:"#ef4444",fontFamily:"IBM Plex Mono,monospace"}}>{"error: "+l.detail.error}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* MAIN LAYOUT - content + sidebar */}
      <div style={{flex:1,display:"flex",overflow:"hidden"}}>

        {/* main content */}
        <div style={{flex:1,overflowY:"auto",padding:"14px 16px",minWidth:0}}>

        {/* TODAY */}
        {tab==="today"&&(
          <div>
            {alerts.length>0&&(
              <div style={{marginBottom:10}}>
                {alerts.map(function(a,i){
                  var isTarget=a.type==="TARGET_HIT";
                  return (
                    <div key={i} style={{background:isTarget?"#10b98115":"#ef444415",border:"1px solid "+(isTarget?"#10b981":"#ef4444"),borderRadius:8,padding:"10px 14px",marginBottom:6,display:"flex",alignItems:"center",gap:10}}>
                      <div style={{width:6,height:6,borderRadius:"50%",background:isTarget?"#10b981":"#ef4444",animation:"_dot 1s ease infinite"}}/>
                      <div style={{flex:1}}>
                        <div style={{fontSize:12,fontWeight:600,color:isTarget?"#10b981":"#ef4444",fontFamily:"Inter,sans-serif"}}>{isTarget?"Target hit":"Stop-loss breached"}</div>
                        <div style={{fontSize:11,color:"#c8d4e8",marginTop:1}}>{a.msg}</div>
                      </div>
                      <button onClick={function(){var pos=portfolio.find(function(p){return p.symbol===a.symbol&&p.status==="OPEN";}); if(pos){setSellTarget(pos.id);setSellPrice(String(a.price));} setTab("positions");}} style={{padding:"4px 10px",borderRadius:5,border:"1px solid "+(isTarget?"#10b981":"#ef4444"),background:"transparent",color:isTarget?"#10b981":"#ef4444",fontSize:10,cursor:"pointer",fontFamily:"IBM Plex Mono,monospace"}}>{isTarget?"take profit":"exit now"}</button>
                    </div>
                  );
                })}
              </div>
            )}
            {brief?(
              <div style={card(brief.mood==="POSITIVE"?"#10b981":brief.mood==="CAUTIOUS"?"#f59e0b":"#1c2333")}>
                <div style={{fontSize:14,fontWeight:600,color:"#e2e8f0",marginBottom:6,lineHeight:1.4,fontFamily:"IBM Plex Sans,sans-serif"}}>{brief.headline}</div>
                {brief.market_note&&<div style={{fontSize:11,color:"#4a5568",marginBottom:3,fontFamily:"IBM Plex Sans,sans-serif"}}>{brief.market_note}</div>}
                {brief.portfolio_flag&&<div style={{fontSize:11,color:"#f59e0b",marginBottom:3}}>! {brief.portfolio_flag}</div>}
                {brief.top_action&&<div style={{fontSize:11,color:"#3b82f6"}}>-&gt; {brief.top_action}</div>}
                {market&&<div style={{fontSize:9,color:"#1c2333",marginTop:6}}>{"updated "+timeAgo(market.fetched_at||new Date().toISOString())+" - scan #"+(memory.scan_count||0)}</div>}
              </div>
            ):autoRunning?(
              <div style={card()}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                  <div style={{width:5,height:5,borderRadius:"50%",background:"#f59e0b",animation:"_dot 1s ease infinite"}}/>
                  <span style={{fontSize:10,color:"#4a5568"}}>{scanPhase==="discovery"?"auto-discovering stocks...":scanPhase==="market"?"fetching NEPSE market...":scanSym?"scanning "+scanSym:"starting scan..."}</span>
                </div>
                {ghost(55)}{ghost(75)}{ghost(40)}
              </div>
            ):(
              <div style={card()}>
                <div style={{fontSize:11,color:"#4a5568",marginBottom:8}}>No brief yet.</div>
                <button onClick={runScan} style={btn("#3b82f6")}>run scan now</button>
              </div>
            )}

            {/* discovered stocks banner */}
            {signals.filter(function(s){return s.source==="discovered";}).length>0&&(
              <div style={{background:"#0d1018",border:"1px solid #10b98133",borderRadius:8,padding:"10px 14px",marginBottom:8}}>
                <div style={{fontSize:9,color:"#10b981",letterSpacing:".08em",marginBottom:6}}>AUTO-DISCOVERED TODAY</div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  {signals.filter(function(s){return s.source==="discovered";}).map(function(s) {
                    var sc=SIG_COLORS[s.signal]||"#4a5568";
                    return (
                      <div key={s.symbol} onClick={function(){openStock(s.symbol);}} style={{background:"#080a0f",border:"1px solid "+sc+"44",borderRadius:5,padding:"5px 10px",cursor:"pointer"}}>
                        <span style={{fontSize:11,fontWeight:600,color:"#e2e8f0"}}>{s.symbol}</span>
                        <span style={{fontSize:9,color:sc,marginLeft:6}}>{s.signal}</span>
                        {s.live&&<span style={{fontSize:9,color:"#4a5568",marginLeft:4}}>{"Rs"+s.live.price}</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* market movers */}
            {market&&(market.gainers||[]).length>0&&(
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                <div style={{background:"#0d1018",border:"1px solid #1c2333",borderRadius:8,padding:"10px 12px"}}>
                  <div style={{fontSize:9,color:"#10b981",letterSpacing:".08em",marginBottom:6}}>GAINERS</div>
                  {(market.gainers||[]).slice(0,4).map(function(g,i) {
                    return <div key={i} onClick={function(){openStock(g.symbol);}} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",borderTop:"1px solid #1c2333",cursor:"pointer"}}>
                      <span style={{color:"#e2e8f0",fontSize:11,fontWeight:500}}>{g.symbol}</span>
                      <span style={{fontSize:10,color:"#10b981"}}>{"+"+(g.pct||0).toFixed(1)+"%"}</span>
                    </div>;
                  })}
                </div>
                <div style={{background:"#0d1018",border:"1px solid #1c2333",borderRadius:8,padding:"10px 12px"}}>
                  <div style={{fontSize:9,color:"#ef4444",letterSpacing:".08em",marginBottom:6}}>LOSERS</div>
                  {(market.losers||[]).slice(0,4).map(function(g,i) {
                    return <div key={i} onClick={function(){openStock(g.symbol);}} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",borderTop:"1px solid #1c2333",cursor:"pointer"}}>
                      <span style={{color:"#e2e8f0",fontSize:11,fontWeight:500}}>{g.symbol}</span>
                      <span style={{fontSize:10,color:"#ef4444"}}>{(g.pct||0).toFixed(1)+"%"}</span>
                    </div>;
                  })}
                </div>
              </div>
            )}

            {/* top buy signals */}
            {signals.filter(function(s){return s.signal==="BUY";}).slice(0,3).map(function(s) {
              var sc=SIG_COLORS[s.signal];
              return (
                <div key={s.id} style={card(sc)}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6,flexWrap:"wrap"}}>
                    <span style={{fontSize:13,fontWeight:600,color:"#e2e8f0"}}>{s.symbol}</span>
                    <span style={{fontSize:9,fontWeight:700,color:sc,background:sc+"20",padding:"1px 6px",borderRadius:3}}>{s.signal}</span>
                    <span style={{fontSize:9,color:s.confidence==="HIGH"?"#10b981":s.confidence==="MEDIUM"?"#f59e0b":"#4a5568"}}>{s.confidence}</span>
                    {s.live&&<span style={{fontSize:8,color:"#10b981",background:"#10b98118",padding:"1px 5px",borderRadius:2}}>{"Rs"+s.live.price}</span>}
                    {s.source==="discovered"&&<span style={{fontSize:8,color:"#a78bfa",background:"#a78bfa18",padding:"1px 5px",borderRadius:2}}>discovered</span>}
                  </div>
                  <div style={{fontSize:11,color:"#8899b4",lineHeight:1.7,marginBottom:8,padding:"7px 10px",background:"#080a0f",borderRadius:4,fontFamily:"IBM Plex Sans,sans-serif"}}>{s.why}</div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:5,marginBottom:8}}>
                    {sbox("entry",s.entry)}{sbox("stop loss",s.sl?"Rs "+s.sl:"-","#ef4444")}{sbox("target",s.target?"Rs "+s.target:"-","#10b981")}
                  </div>
                  {s.action&&<div style={{fontSize:11,color:"#3b82f6",marginBottom:8,fontFamily:"IBM Plex Sans,sans-serif"}}>-&gt; {s.action}</div>}
                  {buyTarget===s.id?(
                    <div style={{background:"#080a0f",borderRadius:6,padding:10,border:"1px solid #1c2333"}}>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                        <div><div style={{fontSize:9,color:"#4a5568",marginBottom:3}}>quantity</div><input value={buyQty} onChange={function(e){setBuyQty(e.target.value);}} type="number" placeholder="units"/></div>
                        <div><div style={{fontSize:9,color:"#4a5568",marginBottom:3}}>stop loss</div><input value={buySL} onChange={function(e){setBuySL(e.target.value);}} type="number" placeholder={s.sl?"Rs "+s.sl:""}/></div>
                      </div>
                      <div style={{marginBottom:8}}><div style={{fontSize:9,color:"#4a5568",marginBottom:3}}>why? <span style={{color:"#ef4444"}}>required</span></div><input value={buyReason} onChange={function(e){setBuyReason(e.target.value);}} placeholder="your reason"/></div>
                      {buyQty&&s.price&&<BuyChargePreview qty={buyQty} price={s.price}/>}
                      <div style={{display:"flex",gap:6}}>
                        <button onClick={function(){logBuy(s);}} style={{flex:1,padding:"7px",borderRadius:6,border:"1px solid #10b981",background:"transparent",color:"#10b981",fontSize:11,cursor:"pointer",fontFamily:"IBM Plex Mono,monospace"}}>confirm buy</button>
                        <button onClick={function(){setBuyTarget(null);setBuyQty("");setBuySL("");setBuyReason("");}} style={btn()}>cancel</button>
                      </div>
                    </div>
                  ):(
                    <div style={{display:"flex",gap:6}}>
                      <button onClick={function(){setBuyTarget(s.id);}} style={btn("#10b981")}>buy</button>
                      <button onClick={function(){openStock(s.symbol);}} style={btn("#3b82f6")}>full view</button>
                      <button onClick={function(){openAsk("Signal "+s.symbol+" "+s.signal+" Rs"+s.price+". "+s.why+" Should I act?");}} style={btn()}>ask</button>
                    </div>
                  )}
                </div>
              );
            })}
            {signals.length===0&&!autoRunning&&(
              <div style={{textAlign:"center",padding:"40px 20px",color:"#4a5568"}}>
                <div style={{fontSize:11,marginBottom:10}}>agent scans on open automatically</div>
                <button onClick={runScan} style={btn("#3b82f6")}>scan now</button>
              </div>
            )}
          </div>
        )}

        {/* POSITIONS */}
        {tab==="positions"&&(
          <div>
            {openPos.length>0&&(
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:12}}>
                {[["open",""+openPos.length,null],["deployed",toRs(openPos.reduce(function(s,p){return s+p.net;},0)),null],["realised",signed(realisedPL),realisedPL>=0?"#10b981":"#ef4444"],["win %",closedSells.length?Math.round(closedSells.filter(function(t){return (t.npl||0)>0;}).length/closedSells.length*100)+"%":"-","#3b82f6"]].map(function(item) {
                  return <div key={item[0]} style={{background:"#0d1018",border:"1px solid #1c2333",borderRadius:6,padding:"8px 10px"}}><div style={{fontSize:9,color:"#4a5568",textTransform:"uppercase",letterSpacing:".06em",marginBottom:3}}>{item[0]}</div><div style={{fontSize:16,fontWeight:600,color:item[2]||"#e2e8f0"}}>{item[1]}</div></div>;
                })}
              </div>
            )}
            {openPos.length===0&&closedSells.length===0&&<div style={{textAlign:"center",padding:"50px 20px",color:"#4a5568",fontSize:11}}>no open positions</div>}
            {openPos.map(function(p) {
              var live=stockCache[p.symbol];
              var sigLive=signals.find(function(s){return s.symbol===p.symbol&&s.live;});
              var lp=live?live.price:(sigLive&&sigLive.live?sigLive.live.price:null);
              var unr=lp?(lp-p.price)*p.qty:null; var noSL=!p.sl;
              var sig=signals.find(function(s){return s.symbol===p.symbol;});
              var sigC=sig?(SIG_COLORS[sig.signal]||"#4a5568"):null;
              return (
                <div key={p.id} style={card(noSL&&daysAgo(p.date)>3?"#ef4444":"#10b981")}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,flexWrap:"wrap"}}>
                    <span style={{fontSize:13,fontWeight:600,color:"#e2e8f0"}}>{p.symbol}</span>
                    <span style={{fontSize:10,color:"#4a5568"}}>{p.qty+"u @ Rs"+p.price}</span>
                    {sig&&sigC&&<span style={{fontSize:9,fontWeight:700,color:sigC,background:sigC+"20",padding:"1px 5px",borderRadius:3}}>{sig.signal}</span>}
                    {lp&&<span style={{fontSize:10,color:"#e2e8f0"}}>{"live Rs"+lp}</span>}
                    {unr!==null&&<span style={{fontSize:10,color:unr>=0?"#10b981":"#ef4444"}}>{(unr>=0?"+":"")+toRs(unr)}</span>}
                    <span style={{marginLeft:"auto",fontSize:9,color:"#4a5568"}}>{"day "+daysAgo(p.date)}</span>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:5,marginBottom:8}}>
                    {sbox("invested",toRs(p.net))}{sbox("break-even",p.be?"Rs "+p.be.toFixed(0):"-")}{sbox("stop loss",p.sl?"Rs "+p.sl:"NOT SET",noSL?"#ef4444":null)}{sbox("target",p.target?"Rs "+p.target:"-",p.target?"#10b981":null)}
                  </div>
                  {p.basis&&<div style={{fontSize:10,color:"#1c2333",fontStyle:"italic",marginBottom:6}}>{'"'+p.basis+'"'}</div>}
                  {noSL&&<div style={{fontSize:10,color:"#ef4444",marginBottom:6}}>no stop-loss set</div>}
                  {sellTarget===p.id?(
                    <div style={{background:"#080a0f",borderRadius:6,padding:10,border:"1px solid #1c2333"}}>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                        <div><div style={{fontSize:9,color:"#4a5568",marginBottom:3}}>sell price <span style={{color:"#ef4444"}}>*</span></div><input value={sellPrice} onChange={function(e){setSellPrice(e.target.value);}} type="number" placeholder={lp?String(lp):"current"}/></div>
                        <div style={{display:"flex",flexDirection:"column",justifyContent:"flex-end"}}>
                          {sellPrice&&<div style={{fontSize:10,color:"#4a5568"}}>net: <span style={{color:calcC("SELL",p.qty,parseFloat(sellPrice),p.price,daysAgo(p.date)).npl>=0?"#10b981":"#ef4444",fontWeight:600}}>{signed(calcC("SELL",p.qty,parseFloat(sellPrice),p.price,daysAgo(p.date)).npl)}</span></div>}
                        </div>
                      </div>
                      <div style={{marginBottom:8}}><div style={{fontSize:9,color:"#4a5568",marginBottom:3}}>why selling? <span style={{color:"#ef4444"}}>required</span></div><input value={sellReason} onChange={function(e){setSellReason(e.target.value);}} placeholder="target hit / stop-loss / thesis changed"/></div>
                      {sellPrice&&(
                        <div style={{fontSize:10,color:"#4a5568",marginBottom:8,padding:"6px 8px",background:"#0d1018",borderRadius:4}}>
                          {"gross "+signed(calcC("SELL",p.qty,parseFloat(sellPrice),p.price,daysAgo(p.date)).gpl)+" charges "+toRs2(calcC("SELL",p.qty,parseFloat(sellPrice),p.price,daysAgo(p.date)).tot)+" net "}
                          <span style={{color:calcC("SELL",p.qty,parseFloat(sellPrice),p.price,daysAgo(p.date)).npl>=0?"#10b981":"#ef4444",fontWeight:600}}>{signed(calcC("SELL",p.qty,parseFloat(sellPrice),p.price,daysAgo(p.date)).npl)}</span>
                        </div>
                      )}
                      <div style={{display:"flex",gap:6}}>
                        <button onClick={function(){logSell(p);}} style={{flex:1,padding:"7px",borderRadius:6,border:"1px solid #ef4444",background:"transparent",color:"#ef4444",fontSize:11,cursor:"pointer",fontFamily:"IBM Plex Mono,monospace"}}>confirm sell</button>
                        <button onClick={function(){setSellTarget(null);setSellPrice("");setSellReason("");}} style={btn()}>cancel</button>
                      </div>
                    </div>
                  ):(
                    <div style={{display:"flex",gap:6}}>
                      <button onClick={function(){setSellTarget(p.id);setSellPrice(lp?String(lp):"");}} style={btn("#ef4444")}>sell</button>
                      <button onClick={function(){openStock(p.symbol);}} style={btn("#3b82f6")}>view</button>
                      <button onClick={function(){sendChat("Review "+p.symbol+" "+p.qty+"u@Rs"+p.price+" "+daysAgo(p.date)+"d BE Rs"+(p.be?p.be.toFixed(2):"?")+(lp?" live Rs"+lp:"")+". Hold or exit?");setTab("ask");}} style={btn()}>ask</button>
                    </div>
                  )}
                </div>
              );
            })}
            {closedSells.length>0&&(
              <div style={{marginTop:12}}>
                <div style={{fontSize:9,color:"#4a5568",letterSpacing:".08em",marginBottom:8}}>CLOSED TRADES</div>
                {closedSells.map(function(t) {
                  return <div key={t.id} style={{display:"flex",gap:10,alignItems:"center",padding:"7px 10px",background:"#0d1018",border:"1px solid #1c2333",borderLeft:"2px solid "+(t.npl>=0?"#10b981":"#ef4444"),borderRadius:6,marginBottom:5}}>
                    <div><span style={{fontSize:12,fontWeight:500,color:"#e2e8f0"}}>{t.symbol}</span><div style={{fontSize:9,color:"#4a5568"}}>{t.qty+"u Rs"+t.price+" "+t.holdDays+"d"}</div></div>
                    <div style={{marginLeft:"auto",textAlign:"right"}}><div style={{fontSize:12,fontWeight:600,color:t.npl>=0?"#10b981":"#ef4444"}}>{signed(t.npl)}</div><div style={{fontSize:9,color:"#4a5568"}}>{"charges "+toRs2(t.tot)}</div></div>
                  </div>;
                })}
              </div>
            )}
          </div>
        )}

        {/* SIGNALS */}
        {tab==="signals"&&(
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{fontSize:10,color:"#4a5568"}}>{signals.length+" signals - "+signals.filter(function(s){return s.source==="discovered";}).length+" discovered"}</div>
              <button onClick={function(){if(!autoRunning){setSignals([]); setBrief(null); setTimeout(runScan,200);}}} disabled={autoRunning} style={btn("#3b82f6")}>{autoRunning?"scanning...":"fresh scan"}</button>
            </div>
            {signals.length===0&&<div style={{textAlign:"center",padding:"50px 20px",color:"#4a5568",fontSize:11}}>no signals yet<br/><br/><button onClick={runScan} style={btn("#3b82f6")}>scan now</button></div>}
            {signals.map(function(s) {
              var sc=SIG_COLORS[s.signal]||"#4a5568"; var d=s.live;
              var isHeld=openPos.find(function(p){return p.symbol===s.symbol;});
              return (
                <div key={s.id} style={card(sc)}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6,flexWrap:"wrap"}}>
                    <span style={{fontSize:13,fontWeight:600,color:"#e2e8f0"}}>{s.symbol}</span>
                    <span style={{fontSize:9,fontWeight:700,color:sc,background:sc+"20",padding:"1px 6px",borderRadius:3}}>{s.signal}</span>
                    <span style={{fontSize:9,color:s.confidence==="HIGH"?"#10b981":s.confidence==="MEDIUM"?"#f59e0b":"#4a5568"}}>{s.confidence}</span>
                    {d&&<span style={{fontSize:8,color:"#10b981",background:"#10b98118",padding:"1px 5px",borderRadius:2}}>{"Rs"+d.price}</span>}
                    {s.source==="discovered"&&<span style={{fontSize:8,color:"#a78bfa",background:"#a78bfa18",padding:"1px 5px",borderRadius:2}}>discovered</span>}
                    {isHeld&&<span style={{fontSize:9,color:"#8b5cf6",background:"#8b5cf622",padding:"1px 5px",borderRadius:3}}>held</span>}
                    <span style={{fontSize:9,color:"#1c2333",marginLeft:"auto"}}>{timeAgo(s.at)}</span>
                  </div>
                  {d&&(
                    <div style={{display:"flex",gap:10,padding:"5px 8px",background:"#080a0f",borderRadius:4,marginBottom:6,flexWrap:"wrap"}}>
                      <span style={{color:"#e2e8f0",fontWeight:600}}>{"Rs "+d.price}</span>
                      <span style={{fontSize:10,color:d.change_pct>=0?"#10b981":"#ef4444"}}>{toPct(d.change_pct)}</span>
                      <span style={{fontSize:9,color:"#4a5568"}}>{"EPS "+d.eps+" PE "+d.pe+" BV Rs"+d.bv}</span>
                    </div>
                  )}
                  <div style={{fontSize:11,color:"#8899b4",lineHeight:1.7,marginBottom:8,padding:"7px 10px",background:"#080a0f",borderRadius:4,fontFamily:"IBM Plex Sans,sans-serif"}}>{s.why}</div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:5,marginBottom:8}}>
                    {sbox("entry",s.entry)}{sbox("stop loss",s.sl?"Rs "+s.sl:"-","#ef4444")}{sbox("target",s.target?"Rs "+s.target:"-","#10b981")}{sbox("hold",s.hold)}
                  </div>
                  {s.risk&&<div style={{fontSize:10,color:"#f59e0b",marginBottom:4,fontFamily:"IBM Plex Sans,sans-serif"}}>{"risk: "+s.risk}</div>}
                  {s.action&&<div style={{fontSize:11,color:"#3b82f6",marginBottom:8,fontFamily:"IBM Plex Sans,sans-serif"}}>-&gt; {s.action}</div>}
                  {buyTarget===s.id?(
                    <div style={{background:"#080a0f",borderRadius:6,padding:10,border:"1px solid #1c2333"}}>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                        <div><div style={{fontSize:9,color:"#4a5568",marginBottom:3}}>quantity</div><input value={buyQty} onChange={function(e){setBuyQty(e.target.value);}} type="number" placeholder="units"/></div>
                        <div><div style={{fontSize:9,color:"#4a5568",marginBottom:3}}>stop loss</div><input value={buySL} onChange={function(e){setBuySL(e.target.value);}} type="number" placeholder={s.sl?"Rs "+s.sl:""}/></div>
                      </div>
                      <div style={{marginBottom:8}}><div style={{fontSize:9,color:"#4a5568",marginBottom:3}}>why? <span style={{color:"#ef4444"}}>required</span></div><input value={buyReason} onChange={function(e){setBuyReason(e.target.value);}} placeholder="your reason"/></div>
                      {buyQty&&s.price&&<BuyChargePreview qty={buyQty} price={s.price}/>}
                      <div style={{display:"flex",gap:6}}>
                        <button onClick={function(){logBuy(s);}} style={{flex:1,padding:"7px",borderRadius:6,border:"1px solid #10b981",background:"transparent",color:"#10b981",fontSize:11,cursor:"pointer",fontFamily:"IBM Plex Mono,monospace"}}>confirm buy</button>
                        <button onClick={function(){setBuyTarget(null);setBuyQty("");setBuySL("");setBuyReason("");}} style={btn()}>cancel</button>
                      </div>
                    </div>
                  ):(
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      {(s.signal==="BUY"||s.signal==="WATCH")&&<button onClick={function(){setBuyTarget(s.id);}} style={btn("#10b981")}>buy</button>}
                      {s.signal==="SELL"&&isHeld&&<button onClick={function(){setSellTarget(isHeld.id);setSellPrice(s.price?String(s.price):"");setTab("positions");}} style={btn("#ef4444")}>sell</button>}
                      <button onClick={function(){openStock(s.symbol);}} style={btn("#3b82f6")}>full view</button>
                      <button onClick={function(){openAsk("Signal "+s.symbol+" "+s.signal+" Rs"+s.price+". "+s.why+" Should I act?");}} style={btn()}>ask</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* WATCHLIST */}
        {tab==="watchlist"&&(
          <div>
            <div style={{fontSize:11,color:"#e2e8f0",fontWeight:600,marginBottom:4}}>Your watchlist</div>
            <div style={{fontSize:11,color:"#4a5568",marginBottom:12,lineHeight:1.7}}>{"Agent scans all "+watchlist.length+" stocks + "+settings.discovery_depth+" auto-discovered per run. BUY signals are auto-added. Stocks with "+settings.autoremove_after+" consecutive NEUTRAL/AVOID scans are auto-removed."}</div>
            <div style={{display:"flex",gap:8,marginBottom:12}}>
              <input value={wlInput} onChange={function(e){setWlInput(e.target.value.toUpperCase());}} onKeyDown={function(e){if(e.key==="Enter"){addToWatchlist(wlInput,"manual");setWlInput("");}}} placeholder="add symbol e.g. SANIMA, CHCL..." style={{flex:1}}/>
              <button onClick={function(){addToWatchlist(wlInput,"manual");setWlInput("");}} style={{padding:"8px 14px",borderRadius:6,border:"1px solid #10b981",background:"transparent",color:"#10b981",fontSize:11,cursor:"pointer",fontFamily:"IBM Plex Mono,monospace",flexShrink:0}}>add</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:6,marginBottom:16}}>
              {watchlist.map(function(sym) {
                var sig=signals.find(function(s){return s.symbol===sym;});
                var sc=sig?(SIG_COLORS[sig.signal]||"#4a5568"):"#1c2333";
                var src=memory.wl_sources&&memory.wl_sources[sym]?memory.wl_sources[sym].source:"manual";
                var srcColor=src==="discovered"?"#a78bfa":src==="holding"?"#8b5cf6":"#4a5568";
                var lp=sig&&sig.live?sig.live.price:null;
                var stale=memory.stale_counts&&memory.stale_counts[sym]?memory.stale_counts[sym]:0;
                return (
                  <div key={sym} style={{background:"#0d1018",border:"1px solid "+sc+"55",borderRadius:6,padding:"8px 10px"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                      <span style={{fontSize:12,fontWeight:600,color:"#e2e8f0",cursor:"pointer"}} onClick={function(){openStock(sym);}}>{sym}</span>
                      <button onClick={function(){removeFromWatchlist(sym);}} style={{fontSize:9,color:"#4a5568",background:"none",border:"none",cursor:"pointer",padding:"0 2px"}}>x</button>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:3}}>
                      <span style={{fontSize:8,color:srcColor}}>{src}</span>
                      {stale>0&&<span style={{fontSize:8,color:"#ef4444"}}>{"stale "+stale+"/"+settings.autoremove_after}</span>}
                    </div>
                    {sig?(
                      <div style={{display:"flex",alignItems:"center",gap:5}}>
                        <span style={{fontSize:9,fontWeight:700,color:sc,background:sc+"20",padding:"1px 5px",borderRadius:2}}>{sig.signal}</span>
                        {lp&&<span style={{fontSize:9,color:"#4a5568"}}>{"Rs"+lp}</span>}
                      </div>
                    ):<span style={{fontSize:9,color:"#4a5568"}}>{autoRunning&&scanSym===sym?"scanning...":"pending"}</span>}
                  </div>
                );
              })}
            </div>
            {memory.last_scan&&(
              <div style={{background:"#0d1018",border:"1px solid #1c2333",borderRadius:8,padding:"12px 14px"}}>
                <div style={{fontSize:11,color:"#e2e8f0",fontWeight:600,marginBottom:6}}>Memory</div>
                <div style={{fontSize:11,color:"#4a5568",lineHeight:1.8}}>
                  <div>{"Scan #"+(memory.scan_count||0)}</div>
                  <div>{"Last: "+memory.last_scan.slice(0,16).replace("T"," ")}</div>
                  {memory.signals_found&&<div>{"Last signals: "+memory.signals_found}</div>}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Ask is now the sidebar - see right panel */}

        {/* SETTINGS */}
        {tab==="settings"&&(
          <div style={{animation:"_fadeup .2s ease forwards"}}>
            <SectionHeader title="Agent Settings" sub="configure how the agent scans and discovers"/>

            {/* Exchange selector */}
            <div style={{background:"#0b0e16",border:"1px solid #1e2840",borderRadius:12,padding:"16px 18px",marginBottom:12}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
                <div style={{width:28,height:28,borderRadius:8,background:"#3b82f618",border:"1px solid #3b82f633",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:"#3b82f6",fontFamily:"IBM Plex Mono,monospace",fontWeight:600}}>ex</div>
                <div>
                  <div style={{fontSize:12,fontWeight:600,color:"#e2e8f0",fontFamily:"Inter,sans-serif"}}>Stock Exchange</div>
                  <div style={{fontSize:10,color:"#4a5568"}}>Which market are you trading</div>
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                {["NEPSE","NYSE"].map(function(exId) {
                  var ex = EXCHANGES[exId];
                  var active = exchange === exId;
                  return (
                    <button key={exId} onClick={function(){ saveExchange(exId); }} style={{padding:"12px 14px",borderRadius:8,border:"1px solid "+(active?"#3b82f6":"#1e2840"),background:active?"#3b82f60e":"transparent",cursor:"pointer",textAlign:"left",transition:"all .15s"}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                        <div style={{width:8,height:8,borderRadius:"50%",background:active?"#3b82f6":"#2a3550",transition:"background .15s"}}/>
                        <span style={{fontSize:12,fontWeight:active?600:400,color:active?"#e2e8f0":"#4a5568",fontFamily:"Inter,sans-serif"}}>{ex.name}</span>
                      </div>
                      <div style={{display:"flex",gap:8,flexWrap:"wrap",paddingLeft:16}}>
                        <span style={{fontSize:9,color:active?"#3b82f6":"#2a3550",background:active?"#3b82f615":"#0f1420",padding:"2px 6px",borderRadius:3,fontFamily:"IBM Plex Mono,monospace"}}>{ex.currency}</span>
                        <span style={{fontSize:9,color:"#2a3550",fontFamily:"IBM Plex Mono,monospace"}}>{ex.hours}</span>
                        <span style={{fontSize:9,color:"#2a3550",fontFamily:"IBM Plex Mono,monospace"}}>{ex.source}</span>
                      </div>
                      {exId==="NYSE"&&<div style={{marginTop:6,paddingLeft:16,fontSize:9,color:"#f59e0b",fontFamily:"Inter,sans-serif"}}>coming in Level 2</div>}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Discovery card */}
            <div style={{background:"#0b0e16",border:"1px solid #1e2840",borderRadius:12,padding:"16px 18px",marginBottom:12}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
                <div style={{width:28,height:28,borderRadius:8,background:"#10b98118",border:"1px solid #10b98133",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>@</div>
                <div>
                  <div style={{fontSize:12,fontWeight:600,color:"#e2e8f0",fontFamily:"Inter,sans-serif"}}>Auto-Discovery</div>
                  <div style={{fontSize:10,color:"#4a5568"}}>Scans NEPSE market movers, finds best signals</div>
                </div>
                <div style={{marginLeft:"auto"}}>
                  <ToggleBtn on={settings.discovery_on} onClick={function(){var u=Object.assign({},settings,{discovery_on:!settings.discovery_on});saveSettings(u);}}/>
                </div>
              </div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 0",borderBottom:"1px solid #0f1420"}}>
                <div>
                  <div style={{fontSize:11,color:"#c8d4e8",fontFamily:"Inter,sans-serif"}}>Discovery depth</div>
                  <div style={{fontSize:10,color:"#4a5568",marginTop:2}}>Stocks to deep-scan from market movers each run</div>
                </div>
                <SegBtn value={settings.discovery_depth} options={[5,8,12]} onChange={function(n){var u=Object.assign({},settings,{discovery_depth:n});saveSettings(u);}}/>
              </div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 0",borderBottom:"1px solid #0f1420"}}>
                <div>
                  <div style={{fontSize:11,color:"#c8d4e8",fontFamily:"Inter,sans-serif"}}>Auto-add threshold</div>
                  <div style={{fontSize:10,color:"#4a5568",marginTop:2}}>Which signal strength triggers auto-add to watchlist</div>
                </div>
                <SegBtn value={settings.autoadd_threshold} options={[["BUY","BUY only"],["BUY_WATCH","BUY + WATCH"]]} onChange={function(v){var u=Object.assign({},settings,{autoadd_threshold:v});saveSettings(u);}}/>
              </div>
            </div>

            {/* Auto-remove card */}
            <div style={{background:"#0b0e16",border:"1px solid #1e2840",borderRadius:12,padding:"16px 18px",marginBottom:12}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
                <div style={{width:28,height:28,borderRadius:8,background:"#ef444418",border:"1px solid #ef444433",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>-</div>
                <div>
                  <div style={{fontSize:12,fontWeight:600,color:"#e2e8f0",fontFamily:"Inter,sans-serif"}}>Auto-Remove</div>
                  <div style={{fontSize:10,color:"#4a5568"}}>Removes stale stocks from watchlist automatically</div>
                </div>
                <div style={{marginLeft:"auto"}}>
                  <ToggleBtn on={settings.autoremove_on} onClick={function(){var u=Object.assign({},settings,{autoremove_on:!settings.autoremove_on});saveSettings(u);}}/>
                </div>
              </div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 0",borderBottom:"1px solid #0f1420"}}>
                <div>
                  <div style={{fontSize:11,color:"#c8d4e8",fontFamily:"Inter,sans-serif"}}>Remove after N stale scans</div>
                  <div style={{fontSize:10,color:"#4a5568",marginTop:2}}>Consecutive NEUTRAL or AVOID before stock is dropped</div>
                </div>
                <SegBtn value={settings.autoremove_after} options={[2,3,5]} onChange={function(n){var u=Object.assign({},settings,{autoremove_after:n});saveSettings(u);}}/>
              </div>
            </div>

            {/* Sector focus card */}
            <div style={{background:"#0b0e16",border:"1px solid #1e2840",borderRadius:12,padding:"16px 18px",marginBottom:12}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                <div style={{width:28,height:28,borderRadius:8,background:"#a78bfa18",border:"1px solid #a78bfa33",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>#</div>
                <div>
                  <div style={{fontSize:12,fontWeight:600,color:"#e2e8f0",fontFamily:"Inter,sans-serif"}}>Sector Focus</div>
                  <div style={{fontSize:10,color:"#4a5568"}}>Discovery prioritises enabled sectors. All on = no bias.</div>
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(148px,1fr))",gap:8,marginTop:12}}>
                {SECTORS.map(function(s) {
                  var on=settings.sector_focus[s];
                  return (
                    <button key={s} onClick={function(){var sf=Object.assign({},settings.sector_focus); sf[s]=!sf[s]; var u=Object.assign({},settings,{sector_focus:sf}); saveSettings(u);}} style={{padding:"10px 12px",borderRadius:8,border:"1px solid "+(on?"#3b82f655":"#1e2840"),background:on?"#3b82f60e":"transparent",color:on?"#3b82f6":"#4a5568",cursor:"pointer",textAlign:"left",transition:"all .15s"}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                        <div style={{width:6,height:6,borderRadius:"50%",background:on?"#3b82f6":"#2a3550"}}/>
                        <span style={{fontSize:11,fontWeight:on?600:400,fontFamily:"Inter,sans-serif"}}>{SECTOR_LABELS[s]}</span>
                      </div>
                      <div style={{fontSize:9,color:on?"#3b82f688":"#2a3550",marginLeft:12}}>{on?"included in discovery":"excluded"}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Scan summary card */}
            <div style={{background:"linear-gradient(135deg,#0b0e16 0%,#0d1220 100%)",border:"1px solid #1e2840",borderRadius:12,padding:"16px 18px"}}>
              <div style={{fontSize:12,fontWeight:600,color:"#e2e8f0",fontFamily:"Inter,sans-serif",marginBottom:12}}>Current scan profile</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:14}}>
                {[
                  ["Watchlist stocks",watchlist.length,"#c8d4e8"],
                  ["+ Discovered",settings.discovery_depth,"#a78bfa"],
                  ["Total scanned",watchlist.length+settings.discovery_depth,"#10b981"]
                ].map(function(item) {
                  return (
                    <div key={item[0]} style={{background:"#07090e",borderRadius:8,padding:"10px 12px",border:"1px solid #141824"}}>
                      <div style={{fontSize:18,fontWeight:700,color:item[2],fontFamily:"IBM Plex Mono,monospace",marginBottom:3}}>{item[1]}</div>
                      <div style={{fontSize:9,color:"#4a5568"}}>{item[0]}</div>
                    </div>
                  );
                })}
              </div>
              <div style={{background:"#07090e",borderRadius:8,padding:"10px 14px",border:"1px solid #141824"}}>
                <div style={{fontSize:10,color:"#4a5568",lineHeight:2}}>
                  <div style={{display:"flex",justifyContent:"space-between"}}><span>1. Market fetch (gainers + losers + turnover)</span><span style={{color:"#2a3550"}}>~20s</span></div>
                  <div style={{display:"flex",justifyContent:"space-between"}}><span>{"2. Discovery scoring ("+settings.discovery_depth+" from ~40 movers)"}</span><span style={{color:"#2a3550"}}>~20s</span></div>
                  <div style={{display:"flex",justifyContent:"space-between"}}><span>{"3. Deep scan ("+(watchlist.length+settings.discovery_depth)+" stocks)"}</span><span style={{color:"#2a3550"}}>{"~"+(watchlist.length+settings.discovery_depth)+"min"}</span></div>
                  <div style={{display:"flex",justifyContent:"space-between"}}><span>4. Brief generation</span><span style={{color:"#2a3550"}}>~15s</span></div>
                </div>
                <div style={{marginTop:8,paddingTop:8,borderTop:"1px solid #141824",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:11,color:"#e2e8f0",fontFamily:"Inter,sans-serif",fontWeight:500}}>Estimated total</span>
                  <span style={{fontSize:14,fontWeight:700,color:"#3b82f6",fontFamily:"IBM Plex Mono,monospace"}}>{"~"+Math.round((watchlist.length+settings.discovery_depth)*1.2+2)+" min"}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>


        {/* ASK SIDEBAR */}
        {sidebarOpen&&(
          <div style={{width:300,borderLeft:"1px solid #141824",display:"flex",flexDirection:"column",background:"#07090e",flexShrink:0}}>
            {/* sidebar header */}
            <div style={{padding:"12px 14px",borderBottom:"1px solid #141824",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
              <div style={{display:"flex",alignItems:"center",gap:7}}>
                <div style={{width:5,height:5,borderRadius:"50%",background:"#3b82f6"}}/>
                <span style={{fontSize:12,fontWeight:500,color:"#e2e8f0",fontFamily:"Inter,sans-serif"}}>Ask agent</span>
              </div>
              <button onClick={function(){setSidebarOpen(false);}} style={{padding:"2px 8px",borderRadius:5,border:"1px solid #1e2840",background:"transparent",color:"#4a5568",fontSize:10,cursor:"pointer",fontFamily:"Inter,sans-serif"}}>close</button>
            </div>
            {/* messages */}
            <div style={{flex:1,overflowY:"auto",padding:"10px 12px"}}>
              {chat.length===0&&(
                <div>
                  <div style={{fontSize:10,color:"#4a5568",marginBottom:10,lineHeight:1.6,fontFamily:"Inter,sans-serif"}}>Ask anything about your portfolio or the market. I fetch live data when needed.</div>
                  {["NABIL current price?","Which positions at risk?","Should I act on GBIME?","What sectors look strong?"].map(function(q) {
                    return <button key={q} onClick={function(){sendChat(q);}} style={{display:"block",width:"100%",textAlign:"left",padding:"7px 10px",marginBottom:4,background:"#0b0e16",border:"1px solid #1e2840",borderRadius:6,color:"#4a5568",fontSize:10,cursor:"pointer",fontFamily:"IBM Plex Mono,monospace",lineHeight:1.4}}>{q}</button>;
                  })}
                </div>
              )}
              {chat.map(function(m,i) {
                var isU=m.role==="user";
                return (
                  <div key={i} style={{marginBottom:8,display:"flex",flexDirection:"column",alignItems:isU?"flex-end":"flex-start"}}>
                    <div style={{maxWidth:"92%",padding:"8px 10px",borderRadius:isU?"8px 8px 2px 8px":"2px 8px 8px 8px",background:isU?"#152515":"#0b0e16",border:"1px solid "+(isU?"#10b98122":"#1e2840"),fontSize:11,lineHeight:1.6,color:isU?"#6ee7b7":"#8899b4",whiteSpace:"pre-wrap",wordBreak:"break-word",fontFamily:"Inter,sans-serif"}}>
                      {m.content}
                    </div>
                    <div style={{fontSize:9,color:"#1e2840",marginTop:2,fontFamily:"IBM Plex Mono,monospace"}}>{timeAgo(m.ts)}</div>
                  </div>
                );
              })}
              {chatLoading&&(
                <div style={{display:"flex",gap:4,padding:"8px 10px",background:"#0b0e16",border:"1px solid #1e2840",borderRadius:"2px 8px 8px 8px",width:"fit-content",alignItems:"center"}}>
                  <div style={{width:4,height:4,borderRadius:"50%",background:"#3b82f6",animation:"_pulse 1.2s ease 0s infinite"}}/>
                  <div style={{width:4,height:4,borderRadius:"50%",background:"#3b82f6",animation:"_pulse 1.2s ease .2s infinite"}}/>
                  <div style={{width:4,height:4,borderRadius:"50%",background:"#3b82f6",animation:"_pulse 1.2s ease .4s infinite"}}/>
                </div>
              )}
              <div ref={sidebarEnd}/>
            </div>
            {/* input */}
            <div style={{padding:"10px 12px",borderTop:"1px solid #141824",flexShrink:0}}>
              <div style={{display:"flex",gap:6}}>
                <input
                  value={chatInput}
                  onChange={function(e){setChatInput(e.target.value);}}
                  onKeyDown={function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendChat("");}}}
                  placeholder="ask anything..."
                  style={{flex:1,fontSize:11,padding:"7px 10px",borderRadius:7,minHeight:36}}
                />
                <button onClick={function(){sendChat("");}} disabled={chatLoading||!chatInput.trim()} style={{width:34,height:34,borderRadius:7,border:"none",background:chatInput.trim()?"#3b82f6":"#1e2840",color:chatInput.trim()?"#fff":"#2a3550",fontSize:13,flexShrink:0,cursor:"pointer"}}>{"up"}</button>
              </div>
            </div>
          </div>
        )}

      </div>{/* end main layout */}

      {/* STOCK OVERLAY */}
      {ovSym&&(
        <div style={{position:"fixed",inset:0,background:"rgba(8,10,15,.95)",zIndex:200,overflowY:"auto",padding:16}}>
          <div style={{maxWidth:680,margin:"0 auto"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
              <span style={{fontSize:18,fontWeight:600,color:"#e2e8f0"}}>{ovSym}</span>
              {ovSig&&<span style={{fontSize:10,fontWeight:700,color:SIG_COLORS[ovSig.signal]||"#4a5568",background:(SIG_COLORS[ovSig.signal]||"#4a5568")+"20",padding:"2px 8px",borderRadius:3}}>{ovSig.signal}</span>}
              {ovLoading&&<span style={{fontSize:10,color:"#4a5568"}}>loading...</span>}
              <button onClick={function(){setOvSym(null);}} style={{marginLeft:"auto",padding:"5px 12px",borderRadius:5,border:"1px solid #1c2333",background:"none",color:"#4a5568",fontSize:11,cursor:"pointer",fontFamily:"IBM Plex Mono,monospace"}}>close</button>
            </div>
            {ovData&&ovData.price&&(
              <div style={card("#10b981")}>
                <div style={{display:"flex",alignItems:"baseline",gap:12,marginBottom:10,flexWrap:"wrap"}}>
                  <span style={{fontSize:22,fontWeight:600,color:"#e2e8f0"}}>{"Rs "+ovData.price}</span>
                  <span style={{fontSize:12,color:ovData.change_pct>=0?"#10b981":"#ef4444"}}>{toPct(ovData.change_pct)}</span>
                  <span style={{fontSize:8,color:"#10b981",background:"#10b98118",padding:"1px 5px",borderRadius:2,marginLeft:"auto"}}>LIVE - merolagani.com</span>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:5,marginBottom:10}}>
                  {[["52w H","Rs "+ovData.week52_high],["52w L","Rs "+ovData.week52_low],["120d","Rs "+ovData.avg120],["EPS",""+ovData.eps],["P/E",""+ovData.pe],["BV","Rs "+ovData.bv],["PBV",""+ovData.pbv],["Div",ovData.div_pct+"%"],["Yield",ovData.yield+"%"],["Vol",""+ovData.volume]].map(function(item){return <div key={item[0]} style={{background:"#080a0f",borderRadius:4,padding:"4px 7px"}}><div style={{fontSize:8,color:"#1c2333",marginBottom:2}}>{item[0]}</div><div style={{fontSize:11,fontWeight:500,color:"#c8d4e8"}}>{item[1]||"-"}</div></div>;})}</div>
                {ovData.week52_low&&ovData.week52_high&&(function(){
                  var pos=Math.min(100,Math.max(0,((ovData.price-ovData.week52_low)/(ovData.week52_high-ovData.week52_low))*100));
                  var bc=pos>75?"#f59e0b":pos<25?"#3b82f6":"#10b981";
                  return <div><div style={{fontSize:9,color:"#4a5568",marginBottom:3}}>{"52-week range - "+Math.round(pos)+"% of range"}</div><div style={{height:4,background:"#1c2333",borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:""+pos+"%",background:bc,borderRadius:2}}/></div><div style={{display:"flex",justifyContent:"space-between",fontSize:8,color:"#1c2333",marginTop:2}}><span>{"Rs "+ovData.week52_low}</span><span>{"Rs "+ovData.week52_high}</span></div></div>;
                })()}
                {ovData.news&&ovData.news.length>0&&<div style={{marginTop:8}}>{ovData.news.slice(0,3).map(function(n,i){return <div key={i} style={{fontSize:10,color:"#4a5568",padding:"3px 0",borderTop:i>0?"1px solid #1c2333":"none",lineHeight:1.5,fontFamily:"IBM Plex Sans,sans-serif"}}>{n}</div>;})}</div>}
              </div>
            )}
            {!ovData&&ovLoading&&<div style={card()}>{ghost()}{ghost()}{ghost()}</div>}
            {ovAnalysis?<div style={{background:"#0d1018",border:"1px solid #1c2333",borderRadius:8,padding:"12px 14px",marginBottom:10,lineHeight:1.8,fontSize:12,color:"#8899b4",whiteSpace:"pre-wrap",fontFamily:"IBM Plex Sans,sans-serif"}}>{ovAnalysis}</div>:ovLoading&&<div style={card()}>{ghost()}{ghost()}{ghost()}{ghost()}</div>}
            {ovSig&&(
              <div style={card(SIG_COLORS[ovSig.signal]||"#4a5568")}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:5,marginBottom:8}}>
                  {sbox("signal",ovSig.signal,SIG_COLORS[ovSig.signal])}{sbox("conf",ovSig.confidence,ovSig.confidence==="HIGH"?"#10b981":ovSig.confidence==="MEDIUM"?"#f59e0b":"#4a5568")}{sbox("entry",ovSig.entry||"-")}{sbox("stop loss",ovSig.sl?"Rs "+ovSig.sl:"-","#ef4444")}{sbox("target",ovSig.target?"Rs "+ovSig.target:"-","#10b981")}
                </div>
                {ovSig.why&&<div style={{fontSize:11,color:"#8899b4",lineHeight:1.7,marginBottom:8,padding:"7px 10px",background:"#080a0f",borderRadius:4,fontFamily:"IBM Plex Sans,sans-serif"}}>{ovSig.why}</div>}
                {ovSig.signal==="BUY"&&<button onClick={function(){setOvSym(null);setBuyTarget(ovSig.id);setBuyQty("");setBuySL(ovSig.sl?String(ovSig.sl):"");setBuyReason(ovSig.why||"");setTab("signals");}} style={btn("#10b981")}>{"log buy for "+ovSym}</button>}
              </div>
            )}
            {watchlist.indexOf(ovSym)<0&&<button onClick={function(){addToWatchlist(ovSym,"manual");showToast(ovSym+" added to watchlist");}} style={{marginTop:8,padding:"5px 12px",borderRadius:7,border:"1px solid #a78bfa",background:"transparent",color:"#a78bfa",fontSize:11,cursor:"pointer",fontFamily:"IBM Plex Mono,monospace"}}>{"+ add "+ovSym+" to watchlist"}</button>}
          </div>
        </div>
      )}
    </div>
  );
}
