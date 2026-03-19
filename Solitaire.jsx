import { useState, useEffect, useCallback } from "react";


// ── constants ──────────────────────────────────────────────────────────────
const SUITS = ['♠','♥','♦','♣'];
const VALS  = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const isRed = s => s === '♥' || s === '♦';
const vi    = v => VALS.indexOf(v);


const canStack = (card, onto) =>
  onto ? onto.up && isRed(card.s) !== isRed(onto.s) && vi(card.v) === vi(onto.v) - 1
       : card.v === 'K';


const canFound = (card, pile) =>
  pile.length === 0
    ? card.v === 'A'
    : card.s === pile[pile.length-1].s && vi(card.v) === vi(pile[pile.length-1].v) + 1;


// ── deck helpers ───────────────────────────────────────────────────────────
const mkDeck = () => SUITS.flatMap(s => VALS.map(v => ({ s, v, up: false, id:`${v}${s}` })));

const mulberry32 = seed => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0;
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

const shuffle = (a, rand) => {
  const b = [...a];
  for (let i = b.length-1; i > 0; i--) {
    const j = Math.floor(rand() * (i+1));
    [b[i],b[j]] = [b[j],b[i]];
  }
  return b;
};


const newGame = seed => {
  const rand = mulberry32(seed);
  const deck = shuffle(mkDeck(), rand);
  const tab = Array.from({length:7}, () => []);
  let k = 0;
  for (let c = 0; c < 7; c++)
    for (let r = 0; r <= c; r++)
      tab[c].push({...deck[k++], up: r===c});
  return {
    tab,
    found: [[],[],[],[]],
    stock: deck.slice(k).map(c => ({...c, up:false})),
    waste: [],
    score: 0,
    moves: 0,
  };
};


// ── shared helpers ─────────────────────────────────────────────────────────
const fmt = s => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;


// ── card dimensions ────────────────────────────────────────────────────────
const CW=66, CH=92, FDU=28, FDD=18;


// ── sub-components ─────────────────────────────────────────────────────────
const Back = ({ style, onClick }) => (
  <div onClick={onClick} style={{
    width:CW, height:CH, borderRadius:8, flexShrink:0, cursor:'pointer',
    border:'1px solid #1e3a8a',
    background:'repeating-linear-gradient(135deg,#1e40af,#1e40af 3px,#1d4ed8 3px,#1d4ed8 9px)',
    ...style
  }}/>
);


const Face = ({ card, sel, style, onClick, onDbl }) => (
  <div onClick={onClick} onDoubleClick={onDbl} style={{
    width:CW, height:CH, borderRadius:8, background:'#fff', flexShrink:0,
    border: sel ? '2px solid #f59e0b' : '1px solid #cbd5e1',
    boxShadow: sel
      ? '0 0 0 3px rgba(251,191,36,.45), 0 4px 12px rgba(0,0,0,.35)'
      : '0 2px 6px rgba(0,0,0,.22)',
    cursor:'pointer', position:'relative',
    color: isRed(card.s) ? '#dc2626' : '#111',
    userSelect:'none', ...style
  }}>
    <div style={{position:'absolute',top:3,left:4,lineHeight:1.15,textAlign:'center'}}>
      <div style={{fontSize:10,fontWeight:700}}>{card.v}</div>
      <div style={{fontSize:10}}>{card.s}</div>
    </div>
    <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:28}}>
      {card.s}
    </div>
    <div style={{position:'absolute',bottom:3,right:4,lineHeight:1.15,textAlign:'center',transform:'rotate(180deg)'}}>
      <div style={{fontSize:10,fontWeight:700}}>{card.v}</div>
      <div style={{fontSize:10}}>{card.s}</div>
    </div>
  </div>
);


const Slot = ({ label, hint, onClick }) => (
  <div onClick={onClick} style={{
    width:CW, height:CH, borderRadius:8, flexShrink:0,
    border:`2px dashed ${hint ? '#f59e0b' : 'rgba(255,255,255,.15)'}`,
    display:'flex', alignItems:'center', justifyContent:'center',
    color: hint ? '#f59e0b' : 'rgba(255,255,255,.22)',
    fontSize:16, cursor:'pointer',
    background: hint ? 'rgba(251,191,36,.08)' : 'rgba(0,0,0,.12)',
  }}>{label}</div>
);


// ── Solitaire (single-player board) ───────────────────────────────────────
function Solitaire({ playerName = '♠ Solitaire', timeLeft = 300, seed, onScoreChange }) {
  const [g, setG]     = useState(() => newGame(seed));
  const [sel, setSel] = useState(null);

  // Report score changes up to the shell
  useEffect(() => {
    if (onScoreChange) onScoreChange(g.score);
  }, [g.score]); // eslint-disable-line react-hooks/exhaustive-deps

  const frozen = timeLeft === 0;

  // Cards currently selected
  const selCards = !sel ? []
    : sel.type === 'waste' ? (g.waste.length ? [g.waste[g.waste.length-1]] : [])
    : sel.type === 'found' ? (g.found[sel.col].length ? [g.found[sel.col][g.found[sel.col].length-1]] : [])
    : g.tab[sel.col].slice(sel.idx);


  const isSel = (type, col, idx) => {
    if (!sel || sel.type !== type) return false;
    if (type === 'waste') return true;
    if (type === 'found') return sel.col === col;
    return sel.col === col && idx >= sel.idx;
  };


  // Remove selected cards from their source (returns new game state)
  const removeSel = (game, s) => {
    const ng = {
      ...game,
      tab:   game.tab.map(p=>[...p]),
      found: game.found.map(f=>[...f]),
      waste: [...game.waste],
      moves: game.moves+1,
    };
    if (s.type === 'waste') {
      ng.waste.pop();
    } else if (s.type === 'found') {
      ng.found[s.col].pop();
    } else {
      ng.tab[s.col] = ng.tab[s.col].slice(0, s.idx);
      if (ng.tab[s.col].length > 0) {
        const last = ng.tab[s.col].length-1;
        if (!ng.tab[s.col][last].up)
          ng.tab[s.col][last] = {...ng.tab[s.col][last], up:true};
      }
    }
    return ng;
  };


  // Functional updater form avoids stale-closure bug on g.found
  const tryAutoFound = (card, source) => {
    setG(prev => {
      for (let fi = 0; fi < 4; fi++) {
        if (canFound(card, prev.found[fi])) {
          const ng = removeSel(prev, source);
          ng.found[fi] = [...prev.found[fi], card];
          ng.score += 10;
          setSel(null);
          return ng;
        }
      }
      return prev;
    });
  };


  // ── event handlers ──────────────────────────────────────────────────────
  const sp = e => e.stopPropagation();


  const onStock = e => {
    sp(e); if (frozen) return; setSel(null);
    setG(g => g.stock.length === 0
      ? {...g, stock:[...g.waste].reverse().map(c=>({...c,up:false})), waste:[]}
      : {...g, stock:g.stock.slice(0,-1), waste:[...g.waste, {...g.stock[g.stock.length-1],up:true}]}
    );
  };


  const onWaste = e => {
    sp(e); if (frozen) return;
    if (!g.waste.length) return;
    if (sel?.type === 'waste') { setSel(null); return; }
    setSel({type:'waste'});
  };


  const dblWaste = e => {
    sp(e); if (frozen) return;
    if (!g.waste.length) return;
    tryAutoFound(g.waste[g.waste.length-1], {type:'waste'});
  };


  const onFound = (fi, e) => {
    sp(e); if (frozen) return;
    if (!sel || !selCards.length) {
      if (g.found[fi].length) setSel({type:'found', col:fi});
      return;
    }
    if (selCards.length === 1 && canFound(selCards[0], g.found[fi])) {
      const ng = removeSel(g, sel);
      ng.found[fi] = [...g.found[fi], selCards[0]];
      ng.score += 10;
      setG(ng); setSel(null);
    } else {
      setSel(null);
    }
  };


  const onTab = (col, idx, e) => {
    sp(e); if (frozen) return;
    const card = g.tab[col][idx];
    if (!card) return;

    // Flip top face-down card
    if (!card.up && idx === g.tab[col].length-1) {
      const tab = g.tab.map(p=>[...p]);
      tab[col][idx] = {...card, up:true};
      setG({...g, tab, moves:g.moves+1}); setSel(null);
      return;
    }
    if (!card.up) return;

    if (!sel) { setSel({type:'tab', col, idx}); return; }
    if (sel.type==='tab' && sel.col===col && sel.idx===idx) { setSel(null); return; }

    if (selCards.length) {
      const onto = g.tab[col][g.tab[col].length-1] ?? null;
      if (canStack(selCards[0], onto) && !(sel.type==='tab' && sel.col===col)) {
        const ng = removeSel(g, sel);
        ng.tab[col] = [...ng.tab[col], ...selCards];
        if (sel.type==='waste') ng.score += 5;
        setG(ng); setSel(null);
        return;
      }
    }
    setSel({type:'tab', col, idx});
  };


  const dblTab = (col, idx, e) => {
    sp(e); if (frozen) return;
    const card = g.tab[col][idx];
    if (!card?.up || idx !== g.tab[col].length-1) return;
    tryAutoFound(card, {type:'tab', col, idx});
  };


  const onEmptyTab = (col, e) => {
    sp(e); if (frozen) return;
    if (!sel || !selCards.length || selCards[0].v !== 'K') { setSel(null); return; }
    const ng = removeSel(g, sel);
    ng.tab[col] = [...ng.tab[col], ...selCards];
    setG(ng); setSel(null);
  };


  const FLABELS = ['♠','♥','♦','♣'];


  return (
    <div
      onClick={() => setSel(null)}
      style={{
        minHeight:'100vh', padding:'12px 8px',
        background:'radial-gradient(ellipse at 50% 20%,#15803d 0%,#166534 45%,#14532d 100%)',
        display:'flex', flexDirection:'column', alignItems:'center',
      }}
    >
      {/* Header */}
      <div onClick={sp} style={{
        width:'100%', maxWidth:524,
        display:'flex', alignItems:'center', justifyContent:'space-between',
        marginBottom:12,
      }}>
        <span style={{color:'#fff',fontSize:20,fontWeight:800,letterSpacing:1,textShadow:'0 2px 4px rgba(0,0,0,.4)'}}>
          {playerName}
        </span>
        <div style={{display:'flex',gap:12,alignItems:'center',color:'rgba(255,255,255,.85)',fontSize:13}}>
          <span>🃏 {g.moves}</span>
        </div>
      </div>


      {/* Top row: Stock · Waste · gap · Foundations */}
      <div onClick={sp} style={{width:'100%',maxWidth:524,display:'flex',gap:8,marginBottom:14}}>
        {g.stock.length > 0
          ? <Back onClick={onStock}/>
          : <Slot label="↺" onClick={onStock}/>
        }

        {g.waste.length > 0
          ? <Face
              card={g.waste[g.waste.length-1]}
              sel={isSel('waste',null,null)}
              onClick={onWaste}
              onDbl={dblWaste}
            />
          : <Slot label="" onClick={sp}/>
        }

        {/* Stock count badge */}
        <div style={{display:'flex',alignItems:'center',paddingLeft:4}}>
          <span style={{color:'rgba(255,255,255,.35)',fontSize:11}}>{g.stock.length} left</span>
        </div>

        <div style={{flex:1}}/>

        {g.found.map((pile,fi) =>
          pile.length > 0
            ? <Face key={fi}
                card={pile[pile.length-1]}
                sel={isSel('found',fi,null)}
                onClick={e=>onFound(fi,e)}
                onDbl={e=>{sp(e);}}
              />
            : <Slot key={fi}
                label={FLABELS[fi]}
                hint={selCards.length===1 && selCards[0].v==='A'}
                onClick={e=>onFound(fi,e)}
              />
        )}
      </div>


      {/* Tableau */}
      <div onClick={sp} style={{width:'100%',maxWidth:524,display:'flex',gap:8,alignItems:'flex-start'}}>
        {g.tab.map((pile,col) => {
          let h = CH;
          if (pile.length > 0) {
            let off = 0;
            pile.forEach((c,i) => { if (i < pile.length-1) off += c.up ? FDU : FDD; });
            h = off + CH;
          }
          return (
            <div key={col} style={{position:'relative',width:CW,height:Math.max(h,CH),flexShrink:0}}>
              {pile.length === 0
                ? <Slot
                    label="K"
                    hint={selCards.length>0 && selCards[0].v==='K'}
                    onClick={e=>onEmptyTab(col,e)}
                  />
                : pile.map((card,ci) => {
                    let top = 0;
                    for (let i = 0; i < ci; i++) top += pile[i].up ? FDU : FDD;
                    return card.up
                      ? <Face key={card.id} card={card}
                          sel={isSel('tab',col,ci)}
                          style={{position:'absolute',top,left:0,zIndex:ci+1}}
                          onClick={e=>onTab(col,ci,e)}
                          onDbl={e=>dblTab(col,ci,e)}
                        />
                      : <Back key={card.id}
                          style={{position:'absolute',top,left:0,zIndex:ci+1,
                            cursor:ci===pile.length-1?'pointer':'default'}}
                          onClick={e=>onTab(col,ci,e)}
                        />;
                  })
              }
            </div>
          );
        })}
      </div>


      {/* Instructions */}
      <div style={{marginTop:16,color:'rgba(255,255,255,.3)',fontSize:11,textAlign:'center',lineHeight:1.8}}>
        Click to select · Click destination to move · Double-click to auto-send to foundation
      </div>
    </div>
  );
}


// ── MultiplayerShell (default export) ─────────────────────────────────────
export default function MultiplayerShell() {
  const [seed, setSeed]                 = useState(() => Math.random());
  const [timeLeft, setTimeLeft]         = useState(300);
  const [activePlayer, setActivePlayer] = useState(0);
  const [scores, setScores]             = useState([0, 0]);

  const gameOver = timeLeft === 0;

  // Shared countdown — never pauses on tab switch (intentional: fair play)
  useEffect(() => {
    if (gameOver) return;
    const id = setInterval(() => setTimeLeft(t => Math.max(0, t - 1)), 1000);
    return () => clearInterval(id);
  }, [gameOver]);

  const onP1ScoreChange = useCallback(s => setScores(prev => [s, prev[1]]), []);
  const onP2ScoreChange = useCallback(s => setScores(prev => [prev[0], s]), []);

  const playAgain = () => {
    setSeed(Math.random());
    setTimeLeft(300);
    setActivePlayer(0);
    setScores([0, 0]);
  };

  const winner = gameOver
    ? scores[0] > scores[1] ? 'Player 1 Wins! 🎉'
    : scores[1] > scores[0] ? 'Player 2 Wins! 🎉'
    : "It's a Tie! 🤝"
    : null;

  const tabStyle = active => ({
    flex: 1,
    padding: '10px 8px',
    background: active ? '#16a34a' : 'rgba(0,0,0,.25)',
    color: active ? '#fff' : 'rgba(255,255,255,.45)',
    border: 'none',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 700,
    transition: 'background .15s',
  });

  return (
    <div style={{ minHeight:'100vh', background:'#14532d' }}>

      {/* Sticky tab bar */}
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'center',
        padding:'8px 12px',
        background:'rgba(0,0,0,.4)',
        position:'sticky', top:0, zIndex:50,
        borderBottom:'1px solid rgba(255,255,255,.08)',
      }}>
        <div style={{ display:'flex', maxWidth:524, width:'100%', alignItems:'center', borderRadius:10, overflow:'hidden' }}>
          <button style={tabStyle(activePlayer === 0)} onClick={() => setActivePlayer(0)}>
            ♠ Player 1 &nbsp;·&nbsp; ★ {scores[0]}
          </button>

          <div style={{
            padding:'0 16px',
            color: timeLeft <= 30 ? '#f87171' : '#fff',
            fontWeight:800, fontSize:17, whiteSpace:'nowrap',
            background:'rgba(0,0,0,.3)',
            alignSelf:'stretch',
            display:'flex', alignItems:'center',
            textShadow:'0 1px 4px rgba(0,0,0,.5)',
          }}>
            ⏱ {fmt(timeLeft)}
          </div>

          <button style={tabStyle(activePlayer === 1)} onClick={() => setActivePlayer(1)}>
            ♠ Player 2 &nbsp;·&nbsp; ★ {scores[1]}
          </button>
        </div>
      </div>

      {/* Both boards always mounted; inactive hidden via display:none */}
      <div style={{ display: activePlayer === 0 ? 'block' : 'none' }}>
        <Solitaire
          key={`p0-${seed}`}
          playerName="♠ Player 1"
          timeLeft={timeLeft}
          seed={seed}
          onScoreChange={onP1ScoreChange}
        />
      </div>
      <div style={{ display: activePlayer === 1 ? 'block' : 'none' }}>
        <Solitaire
          key={`p1-${seed}`}
          playerName="♠ Player 2"
          timeLeft={timeLeft}
          seed={seed}
          onScoreChange={onP2ScoreChange}
        />
      </div>

      {/* Game over modal */}
      {gameOver && (
        <div style={{
          position:'fixed', inset:0, background:'rgba(0,0,0,.75)',
          display:'flex', alignItems:'center', justifyContent:'center', zIndex:100,
        }}>
          <div style={{
            background:'white', borderRadius:20, padding:'40px 48px',
            textAlign:'center', boxShadow:'0 20px 60px rgba(0,0,0,.5)',
            minWidth:300,
          }}>
            <div style={{ fontSize:52, marginBottom:8 }}>🏆</div>
            <h2 style={{ fontSize:28, fontWeight:800, color:'#166534', margin:'0 0 20px' }}>
              {winner}
            </h2>
            <div style={{ display:'flex', gap:32, justifyContent:'center', marginBottom:28 }}>
              <div>
                <div style={{ fontSize:13, color:'#9ca3af', marginBottom:4 }}>Player 1</div>
                <div style={{ fontSize:32, fontWeight:800, color:'#166534' }}>{scores[0]}</div>
              </div>
              <div style={{ fontSize:24, color:'#d1d5db', alignSelf:'center' }}>vs</div>
              <div>
                <div style={{ fontSize:13, color:'#9ca3af', marginBottom:4 }}>Player 2</div>
                <div style={{ fontSize:32, fontWeight:800, color:'#166534' }}>{scores[1]}</div>
              </div>
            </div>
            <button onClick={playAgain} style={{
              padding:'12px 36px', background:'#16a34a', color:'white',
              border:'none', borderRadius:12, fontSize:17, fontWeight:700, cursor:'pointer',
            }}>Play Again</button>
          </div>
        </div>
      )}
    </div>
  );
}
